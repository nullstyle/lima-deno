/**
 * Capture a Lima instance's disk into a standalone, reusable image.
 *
 * Lima 2.x keeps each instance's disk as one standalone file
 * (`~/.lima/<name>/disk` — raw for vz Linux guests, qcow2 for qemu; no
 * backing chain). Capture is therefore: ensure the instance is Stopped,
 * convert/clone that file, and digest the result.
 *
 * qemu-img is required only for qcow2 output (and for raw output from a
 * qcow2 source). Raw capture from a raw source clones with `cp` and needs
 * nothing installed.
 *
 * @module
 */

import { QemuImg } from "@nullstyle/qemu-img";
import type { LimaInstance } from "../instance.ts";
import {
  type CommandRunner,
  DenoCommandRunner,
  runChecked,
} from "../runner.ts";
import type { CallOptions } from "../options.ts";
import { ImageCaptureError } from "./errors.ts";
import type { QemuImgLike } from "./qemu_img_like.ts";
import type { BuiltImage, ImageEvent, ImageFormat } from "./types.ts";
import { sha256File } from "./digest.ts";

/** Options for {@linkcode captureImage}. */
export interface CaptureImageOptions extends CallOptions {
  /** Host path for the produced image. The parent directory must exist. */
  readonly outputPath: string;
  /** Output format. @default "qcow2" */
  readonly format?: ImageFormat;
  /**
   * Compress qcow2 output (`qemu-img convert -c`, zlib clusters — the kind
   * Lima's native reader can always inflate). Ignored for raw output.
   * @default true
   */
  readonly compress?: boolean;
  /**
   * Stop a Running instance first (graceful `limactl stop`). With `false`, a
   * Running instance is an error — capturing a live disk would be
   * crash-inconsistent. @default true
   */
  readonly stop?: boolean;
  /**
   * The qemu-img client to use (`@nullstyle/qemu-img`'s `QemuImg` fits
   * as-is); inject one sharing your fake runner in tests.
   * @default new QemuImg()
   */
  readonly qemuImg?: QemuImgLike;
  /** Runner for the `cp` clone in raw-from-raw capture. @default new DenoCommandRunner() */
  readonly runner?: CommandRunner;
  /** Progress callback (the library never logs). */
  readonly onEvent?: (event: ImageEvent) => void;
}

const QCOW2_MAGIC = [0x51, 0x46, 0x49, 0xfb]; // "QFI\xfb"
const ASIF_MAGIC = [0x73, 0x68, 0x64, 0x77]; // "shdw"

/**
 * Bake a stopped (or stoppable) instance's disk into a standalone image at
 * `outputPath`, and return it with its `sha256:` digest. The instance is
 * left Stopped and never deleted.
 *
 * `timeoutMs` bounds each underlying command (the library-wide convention);
 * to deadline the whole capture, pass `signal: AbortSignal.timeout(…)`.
 */
export async function captureImage(
  instance: LimaInstance,
  options: CaptureImageOptions,
): Promise<BuiltImage> {
  const call: CallOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
  const format = options.format ?? "qcow2";
  const qemuImg = options.qemuImg ?? new QemuImg();
  const emit = options.onEvent ?? (() => {});
  const name = instance.name;

  const info = await instance.info(call);
  if (info === undefined) {
    throw new ImageCaptureError(name, "instance does not exist");
  }
  if (info.dir === undefined) {
    throw new ImageCaptureError(name, "limactl reported no instance directory");
  }

  if (info.status === "Running") {
    if (options.stop === false) {
      throw new ImageCaptureError(
        name,
        "instance is running; stop it or leave stop enabled",
      );
    }
    emit({ type: "phase", phase: "stop", instance: name });
    await instance.stop(call);
  } else if (info.status !== "Stopped") {
    throw new ImageCaptureError(
      name,
      `instance is ${info.status}; capture needs a cleanly stopped instance`,
    );
  }

  emit({ type: "phase", phase: "inspect", instance: name });
  const sourceDisk = `${info.dir}/disk`;
  const sourceFormat = await sniffDiskFormat(name, sourceDisk);

  emit({ type: "phase", phase: "convert", instance: name });
  // Everything is produced and measured at a .tmp path; the rename to
  // outputPath is the last, atomic step — outputPath never holds a partial
  // image.
  const tmpPath = `${options.outputPath}.tmp`;
  let digest: string;
  let sizeBytes: number;
  let virtualSizeBytes: number;
  try {
    if (format === "qcow2") {
      await qemuImg.ensureAvailable(call);
      await qemuImg.convert(sourceDisk, tmpPath, {
        format: "qcow2",
        compress: options.compress ?? true,
        sourceFormat,
        ...call,
      });
    } else if (sourceFormat === "raw") {
      await cloneRaw(
        options.runner ?? new DenoCommandRunner(),
        sourceDisk,
        tmpPath,
        call,
      );
    } else {
      await qemuImg.ensureAvailable(call);
      await qemuImg.convert(sourceDisk, tmpPath, {
        format: "raw",
        sourceFormat,
        ...call,
      });
    }

    emit({ type: "phase", phase: "digest", instance: name });
    digest = await sha256File(tmpPath, {
      ...(call.signal === undefined ? {} : { signal: call.signal }),
      onProgress: (bytesHashed, totalBytes) =>
        emit({ type: "digest-progress", bytesHashed, totalBytes }),
    });
    sizeBytes = (await Deno.stat(tmpPath)).size;
    virtualSizeBytes = format === "qcow2"
      ? (await qemuImg.info(tmpPath, call)).virtualSizeBytes ?? sizeBytes
      : sizeBytes;

    await Deno.rename(tmpPath, options.outputPath);
  } catch (error) {
    await Deno.remove(tmpPath).catch(() => {});
    throw error;
  }
  const path = await Deno.realPath(options.outputPath);

  return {
    path,
    format,
    digest,
    ...(info.arch === undefined ? {} : { arch: info.arch }),
    sizeBytes,
    virtualSizeBytes,
  };
}

async function sniffDiskFormat(
  instance: string,
  diskPath: string,
): Promise<"qcow2" | "raw"> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(diskPath, { read: true });
  } catch (error) {
    throw new ImageCaptureError(
      instance,
      `cannot read ${diskPath} — Lima 2.x keeps the disk there; ` +
        "a Lima 1.x basedisk/diffdisk layout is not supported",
      { cause: error },
    );
  }
  try {
    const head = new Uint8Array(4);
    let filled = 0;
    while (filled < 4) {
      const read = await file.read(head.subarray(filled));
      if (read === null) break;
      filled += read;
    }
    if (matches(head, filled, QCOW2_MAGIC)) return "qcow2";
    if (matches(head, filled, ASIF_MAGIC)) {
      throw new ImageCaptureError(
        instance,
        "the disk is in Apple's ASIF format, which qemu-img cannot read; " +
          "ASIF capture is unsupported",
      );
    }
    return "raw";
  } finally {
    file.close();
  }
}

function matches(
  head: Uint8Array,
  filled: number,
  magic: readonly number[],
): boolean {
  return filled >= magic.length &&
    magic.every((byte, index) => head[index] === byte);
}

async function cloneRaw(
  runner: CommandRunner,
  source: string,
  dest: string,
  call: CallOptions,
): Promise<void> {
  if (Deno.build.os === "darwin") {
    // APFS clonefile: instant and sparse-preserving. Falls back to a plain
    // copy when the clone fails (e.g. across volumes).
    const clone = await runner.run("cp", ["-c", source, dest], call);
    if (clone.success) return;
    await runChecked(runner, "cp", [source, dest], call);
    return;
  }
  await runChecked(
    runner,
    "cp",
    ["--reflink=auto", "--sparse=always", source, dest],
    call,
  );
}
