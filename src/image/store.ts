/**
 * A local image catalog: digest-named image files plus one `manifest.json`.
 *
 * Layout under the store directory:
 *
 * ```text
 * <dir>/manifest.json                  # v1, names sorted, byte-stable
 * <dir>/<name>-<digest12>.<qcow2|raw>  # the image files
 * ```
 *
 * The manifest is written atomically (`.tmp` → rename) and deterministically
 * (sorted names, 2-space indent, trailing newline) so it diffs cleanly.
 * Single-writer: concurrent processes mutating one store are not supported.
 *
 * @module
 */

import type { ImageSpec } from "../config/types.ts";
import { ImageStoreError } from "./errors.ts";
import type { BuiltImage, ImageFormat } from "./types.ts";
import { toImageSpec } from "./spec.ts";

/** Options for {@linkcode ImageStore}. */
export interface ImageStoreOptions {
  /** Store directory. Explicit — no env sniffing, no implicit default. */
  readonly dir: string;
  /** Clock, for deterministic `createdAt` stamps in tests. @default () => new Date() */
  readonly now?: () => Date;
}

/** One stored image: {@linkcode BuiltImage} data plus its catalog identity. */
export interface StoredImage extends BuiltImage {
  /** The name the image is stored under. */
  readonly name: string;
  /** ISO 8601 timestamp of when it was put. */
  readonly createdAt: string;
}

/** Options for {@linkcode ImageStore.put}. */
export interface ImageStorePutOptions {
  /**
   * Move the file into the store instead of copying (a cross-device move
   * falls back to copy+remove). @default false
   */
  readonly move?: boolean;
}

const MANIFEST = "manifest.json";
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

interface ManifestEntry {
  readonly file: string;
  readonly format: ImageFormat;
  readonly digest: string;
  readonly arch?: string;
  readonly sizeBytes: number;
  readonly virtualSizeBytes: number;
  readonly createdAt: string;
}

interface Manifest {
  readonly version: 1;
  readonly images: Record<string, ManifestEntry>;
}

/** The catalog. See the module doc. */
export class ImageStore {
  /** The store directory. */
  readonly dir: string;
  readonly #now: () => Date;

  /** Create a handle; nothing is touched until the first operation. */
  constructor(options: ImageStoreOptions) {
    this.dir = options.dir;
    this.#now = options.now ?? (() => new Date());
  }

  /** Create the directory and an empty manifest when absent. Idempotent. */
  async init(): Promise<void> {
    await Deno.mkdir(this.dir, { recursive: true });
    try {
      await Deno.stat(this.#manifestPath());
    } catch {
      await this.#writeManifest({ version: 1, images: {} });
    }
  }

  /** Every stored image, sorted by name. */
  async list(): Promise<StoredImage[]> {
    const manifest = await this.#readManifest();
    const names = Object.keys(manifest.images).sort();
    const images: StoredImage[] = [];
    for (const name of names) {
      images.push(await this.#stored(name, manifest.images[name]));
    }
    return images;
  }

  /** One stored image, or `undefined` when absent. */
  async get(name: string): Promise<StoredImage | undefined> {
    const entry = (await this.#readManifest()).images[name];
    return entry === undefined ? undefined : await this.#stored(name, entry);
  }

  /**
   * Store an image under `name` (overwriting any previous image of that
   * name) and return its stored identity.
   */
  async put(
    name: string,
    image: BuiltImage,
    options: ImageStorePutOptions = {},
  ): Promise<StoredImage> {
    if (!NAME_PATTERN.test(name)) {
      throw new ImageStoreError(
        `image names must match ${NAME_PATTERN} (got ${JSON.stringify(name)})`,
        this.dir,
      );
    }
    await this.init();
    const manifest = await this.#readManifest();
    const file = `${name}-${digest12(image.digest)}.${image.format}`;
    const dest = `${this.dir}/${file}`;

    if (options.move === true) {
      try {
        await Deno.rename(image.path, dest);
      } catch {
        // Cross-device (EXDEV) or similar: fall back to copy + remove.
        await Deno.copyFile(image.path, dest);
        await Deno.remove(image.path);
      }
    } else {
      await Deno.copyFile(image.path, dest);
    }

    const previous = manifest.images[name];
    if (previous !== undefined && previous.file !== file) {
      await Deno.remove(`${this.dir}/${previous.file}`).catch(() => {});
    }

    const entry: ManifestEntry = {
      file,
      format: image.format,
      digest: image.digest,
      ...(image.arch === undefined ? {} : { arch: image.arch }),
      sizeBytes: image.sizeBytes,
      virtualSizeBytes: image.virtualSizeBytes,
      createdAt: this.#now().toISOString(),
    };
    await this.#writeManifest({
      version: 1,
      images: { ...manifest.images, [name]: entry },
    });
    return await this.#stored(name, entry);
  }

  /** Delete a stored image (file + entry). Returns `false` when absent. */
  async remove(name: string): Promise<boolean> {
    const manifest = await this.#readManifest();
    const entry = manifest.images[name];
    if (entry === undefined) return false;
    await Deno.remove(`${this.dir}/${entry.file}`).catch(() => {});
    const images = { ...manifest.images };
    delete images[name];
    await this.#writeManifest({ version: 1, images });
    return true;
  }

  /**
   * An `images:` entry for a stored image — absolute `location`, `arch`,
   * `digest` — or `undefined` when absent.
   */
  async resolve(name: string): Promise<ImageSpec | undefined> {
    const image = await this.get(name);
    return image === undefined ? undefined : toImageSpec(image);
  }

  #manifestPath(): string {
    return `${this.dir}/${MANIFEST}`;
  }

  async #stored(name: string, entry: ManifestEntry): Promise<StoredImage> {
    return {
      name,
      path: await Deno.realPath(`${this.dir}/${entry.file}`),
      format: entry.format,
      digest: entry.digest,
      ...(entry.arch === undefined ? {} : { arch: entry.arch }),
      sizeBytes: entry.sizeBytes,
      virtualSizeBytes: entry.virtualSizeBytes,
      createdAt: entry.createdAt,
    };
  }

  async #readManifest(): Promise<Manifest> {
    let text: string;
    try {
      text = await Deno.readTextFile(this.#manifestPath());
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return { version: 1, images: {} };
      }
      throw new ImageStoreError(
        "cannot read store manifest",
        this.#manifestPath(),
        { cause: error },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ImageStoreError(
        "store manifest is not valid JSON",
        this.#manifestPath(),
        { cause: error },
      );
    }
    if (
      parsed === null || typeof parsed !== "object" ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { images?: unknown }).images !== "object"
    ) {
      throw new ImageStoreError(
        "store manifest has an unsupported shape (want version 1)",
        this.#manifestPath(),
      );
    }
    return parsed as Manifest;
  }

  async #writeManifest(manifest: Manifest): Promise<void> {
    const names = Object.keys(manifest.images).sort();
    const images: Record<string, ManifestEntry> = {};
    for (const name of names) images[name] = manifest.images[name];
    const text = `${JSON.stringify({ version: 1, images }, null, 2)}\n`;
    const tmp = `${this.#manifestPath()}.tmp`;
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, this.#manifestPath());
  }
}

function digest12(digest: string): string {
  return digest.replace(/^sha\d+:/, "").slice(0, 12);
}
