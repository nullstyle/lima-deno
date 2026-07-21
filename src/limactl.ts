/**
 * {@linkcode Limactl} — the client: toolkit-level operations (version,
 * listing, creation, disks) and a factory for name-bound
 * {@linkcode import("./instance.ts").LimaInstance} handles.
 *
 * @example Create, use, and delete an instance
 * ```ts
 * import { Limactl } from "@nullstyle/lima";
 *
 * const lima = new Limactl();
 * await lima.requireVersion();
 * const vm = await lima.create("demo", { template: "ubuntu-24.04" }, {
 *   vmType: "vz",
 * });
 * try {
 *   await vm.waitReady();
 *   console.log((await vm.exec("uname -a", { check: true })).stdout);
 * } finally {
 *   await vm.delete();
 * }
 * ```
 *
 * @module
 */

import { type CommandResult, runChecked, type RunOptions } from "./runner.ts";
import { LimaVersionError } from "./errors.ts";
import {
  compareLimactlVersions,
  LIMA_COMPAT,
  type LimactlVersion,
  parseLimactlVersion,
} from "./version.ts";
import { type InstanceInfo, parseInstanceList } from "./status.ts";
import { LimaInstance } from "./instance.ts";
import { type LimaConfig, renderLimaYaml } from "./config/mod.ts";
import {
  buildRunOptions,
  type CallOptions,
  type LimactlOptions,
  type ResolvedOptions,
  resolveOptions,
} from "./options.ts";

/**
 * Where a new instance's configuration comes from:
 * - `{file}` — a rendered template on disk (`limactl start … FILE`);
 * - `{template}` — a builtin template name (`… template:ubuntu-24.04`);
 * - `{url}` — a remote template (`… https://…`);
 * - `{yaml}` — pre-rendered YAML piped via stdin (`… -`);
 * - `{config}` — a typed {@linkcode LimaConfig}, rendered and piped via stdin.
 */
export type CreateSource =
  | { readonly file: string }
  | { readonly template: string }
  | { readonly url: string }
  | { readonly yaml: string }
  | { readonly config: LimaConfig };

/** Flag overrides for {@linkcode Limactl.create} (`limactl start` flags). */
export interface CreateOptions extends CallOptions {
  /** `--vm-type`. */
  readonly vmType?: "qemu" | "vz";
  /** `--nested-virt` (vz; Apple Silicon M3+, macOS 15+). */
  readonly nestedVirtualization?: boolean;
  /** `--rosetta`. */
  readonly rosetta?: boolean;
  /** `--cpus`. */
  readonly cpus?: number;
  /** `--memory` (GiB). */
  readonly memoryGiB?: number;
  /** `--disk` (GiB). */
  readonly diskGiB?: number;
  /** `--mount` entries (Lima `dir[:w]` syntax, passed through). */
  readonly mounts?: readonly string[];
  /** `--network`. */
  readonly network?: string;
  /** `--plain`. */
  readonly plain?: boolean;
  /** `--set` yq expressions — the power escape hatch. */
  readonly set?: readonly string[];
}

/** One disk, as reported by `limactl disk ls --json`. */
export interface DiskInfo {
  /** The disk name. */
  readonly name: string;
  /** Size in bytes. */
  readonly size?: number;
  /** Disk image format (e.g. `"raw"`). */
  readonly format?: string;
  /** The disk directory (under `~/.lima/_disks`). */
  readonly dir?: string;
  /** The instance currently using the disk, when attached. */
  readonly instance?: string;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** The Lima client. */
export class Limactl {
  readonly #o: ResolvedOptions;
  readonly #options: LimactlOptions;

  /** Create a client; all options default (real runner, `"limactl"`). */
  constructor(options: LimactlOptions = {}) {
    this.#options = options;
    this.#o = resolveOptions(options);
  }

  /** The `limactl` binary this client drives. */
  get bin(): string {
    return this.#o.bin;
  }

  /** Whether `limactl --version` runs successfully (`false` when the binary is missing). */
  async available(): Promise<boolean> {
    try {
      const result = await this.#o.runner.run(
        this.#o.bin,
        ["--version"],
        buildRunOptions(this.#o),
      );
      return result.success;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    }
  }

  /** The parsed `limactl --version`. Throws {@linkcode LimaVersionError} when limactl is missing. */
  async version(): Promise<LimactlVersion> {
    let result: CommandResult;
    try {
      result = await this.#o.runner.run(
        this.#o.bin,
        ["--version"],
        buildRunOptions(this.#o),
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        throw new LimaVersionError(LIMA_COMPAT.minimum);
      }
      throw error;
    }
    if (!result.success) throw new LimaVersionError(LIMA_COMPAT.minimum);
    return parseLimactlVersion(result.stdout);
  }

  /**
   * Assert a minimum limactl version (default
   * {@linkcode LIMA_COMPAT}.minimum); returns the parsed version.
   */
  async requireVersion(minimum?: string): Promise<LimactlVersion> {
    const floor = minimum ?? LIMA_COMPAT.minimum;
    const found = await this.version();
    if (compareLimactlVersions(found, parseLimactlVersion(floor)) < 0) {
      throw new LimaVersionError(floor, found);
    }
    return found;
  }

  /** All instances, typed, via `limactl list --json`. */
  async list(): Promise<InstanceInfo[]> {
    const result = await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["list", "--json"],
      buildRunOptions(this.#o),
    );
    return parseInstanceList(result.stdout);
  }

  /** Instance names only, via `limactl list -q`. */
  async listNames(): Promise<string[]> {
    const result = await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["list", "-q"],
      buildRunOptions(this.#o),
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** One instance's info, or `undefined` when absent. */
  async get(name: string): Promise<InstanceInfo | undefined> {
    return (await this.list()).find((info) => info.name === name);
  }

  /** Whether the named instance exists. */
  async exists(name: string): Promise<boolean> {
    return (await this.listNames()).includes(name);
  }

  /** A name-bound handle sharing this client's runner and defaults. */
  instance(name: string): LimaInstance {
    return new LimaInstance(name, this.#options);
  }

  /**
   * Create and boot a new instance:
   * `limactl start --name=<name> [flags] --tty=false <source>`. Returns the
   * instance handle.
   */
  async create(
    name: string,
    source: CreateSource,
    options: CreateOptions = {},
  ): Promise<LimaInstance> {
    const [sourceArg, stdin] = resolveSource(source);
    const args = [
      "start",
      `--name=${name}`,
      ...createFlags(options),
      "--tty=false",
      sourceArg,
    ];
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      args,
      buildRunOptions(this.#o, options, stdin === undefined ? {} : { stdin }),
    );
    return this.instance(name);
  }

  /** Escape hatch: run raw limactl argv through the seam (recorded by fakes like everything else). */
  async raw(
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    return await this.#o.runner.run(this.#o.bin, args, {
      ...buildRunOptions(this.#o, options, {
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
        ...(options.uncapped === undefined
          ? {}
          : { uncapped: options.uncapped }),
      }),
    });
  }

  /** Create a disk: `limactl disk create <name> --size=<size>` (Lima size grammar, e.g. `"10GiB"`). */
  async diskCreate(
    name: string,
    options: { readonly size: string; readonly format?: string } & CallOptions,
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      [
        "disk",
        "create",
        name,
        `--size=${options.size}`,
        ...(options.format === undefined ? [] : [`--format=${options.format}`]),
      ],
      buildRunOptions(this.#o, options),
    );
  }

  /** All disks, via `limactl disk ls --json`. */
  async diskList(): Promise<DiskInfo[]> {
    const result = await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["disk", "ls", "--json"],
      buildRunOptions(this.#o),
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map(parseDiskInfo);
  }

  /** Delete a disk: `limactl disk delete <name>`. */
  async diskDelete(name: string, options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["disk", "delete", name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Resize a disk: `limactl disk resize <name> --size=<size>`. */
  async diskResize(
    name: string,
    size: string,
    options: CallOptions = {},
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["disk", "resize", name, `--size=${size}`],
      buildRunOptions(this.#o, options),
    );
  }
}

function resolveSource(
  source: CreateSource,
): [arg: string, stdin: string | undefined] {
  if ("file" in source) return [source.file, undefined];
  if ("template" in source) {
    return [
      source.template.startsWith("template:")
        ? source.template
        : `template:${source.template}`,
      undefined,
    ];
  }
  if ("url" in source) return [source.url, undefined];
  if ("yaml" in source) return ["-", source.yaml];
  return ["-", renderLimaYaml(source.config)];
}

function createFlags(options: CreateOptions): string[] {
  return [
    ...(options.vmType === undefined ? [] : [`--vm-type=${options.vmType}`]),
    ...(options.nestedVirtualization === true ? ["--nested-virt"] : []),
    ...(options.rosetta === true ? ["--rosetta"] : []),
    ...(options.cpus === undefined ? [] : [`--cpus=${options.cpus}`]),
    ...(options.memoryGiB === undefined
      ? []
      : [`--memory=${options.memoryGiB}`]),
    ...(options.diskGiB === undefined ? [] : [`--disk=${options.diskGiB}`]),
    ...(options.mounts ?? []).map((mount) => `--mount=${mount}`),
    ...(options.network === undefined ? [] : [`--network=${options.network}`]),
    ...(options.plain === true ? ["--plain"] : []),
    ...(options.set ?? []).map((expression) => `--set=${expression}`),
  ];
}

function parseDiskInfo(line: string): DiskInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { name: line, raw: {} };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { name: String(parsed), raw: {} };
  }
  const raw = parsed as Record<string, unknown>;
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    ...(typeof raw.size === "number" ? { size: raw.size } : {}),
    ...(typeof raw.format === "string" ? { format: raw.format } : {}),
    ...(typeof raw.dir === "string" ? { dir: raw.dir } : {}),
    ...(typeof raw.instance === "string" ? { instance: raw.instance } : {}),
    raw,
  };
}
