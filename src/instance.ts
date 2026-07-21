/**
 * {@linkcode LimaInstance} — a name-bound handle on one Lima instance:
 * lifecycle, guest execution, file transfer, readiness, snapshots.
 *
 * Every operation flows through the injected
 * {@linkcode import("./runner.ts").CommandRunner}, so a recording fake drives
 * the whole surface with no VM present and tests assert the exact argv order.
 *
 * @example
 * ```ts
 * import { LimaInstance } from "@nullstyle/lima";
 *
 * const vm = new LimaInstance("default");
 * if (await vm.exists()) {
 *   await vm.start();
 *   await vm.waitReady();
 *   const result = await vm.exec("uname -a", { check: true });
 *   console.log(result.stdout);
 * }
 * ```
 *
 * @module
 */

import {
  CommandAbortedError,
  type CommandResult,
  runChecked,
} from "./runner.ts";
import {
  GuestExecError,
  InstanceBrokenError,
  WaitTimeoutError,
} from "./errors.ts";
import { buildShellArgv, shellQuote, strictWrap, sudoWrap } from "./shell.ts";
import {
  type InstanceInfo,
  type InstanceStatus,
  parseInstanceList,
} from "./status.ts";
import {
  buildRunOptions,
  type CallOptions,
  type LimactlOptions,
  type ResolvedOptions,
  resolveOptions,
} from "./options.ts";

/** Staging path prefix used by {@linkcode LimaInstance.copyInAsRoot}. */
export const LIMA_CP_STAGING_PREFIX = "/tmp/.lima-cp-";

/** Options for {@linkcode LimaInstance.exec}. */
export interface GuestExecOptions extends CallOptions {
  /** When true, a nonzero exit throws {@linkcode GuestExecError}. */
  readonly check?: boolean;
  /** Run privileged: `sudo -E bash -lc '<quoted>'` wrap. @default false */
  readonly sudo?: boolean;
  /** Run as this guest user (implies the sudo wrap). */
  readonly user?: string;
  /** Guest working directory (`limactl shell --workdir`). */
  readonly workdir?: string;
  /** Extra guest environment, exported before the script (shell-quoted). */
  readonly env?: Readonly<Record<string, string>>;
  /** Wrap with `set -euo pipefail; `. @default true */
  readonly strict?: boolean;
}

/** A guest result: the command result plus guest provenance. */
export interface GuestExecResult extends CommandResult {
  /** The Lima instance the script ran in. */
  readonly instance: string;
  /** The script as passed (before strict/sudo wrapping). */
  readonly script: string;
}

/** Options for {@linkcode LimaInstance.command}. */
export interface GuestCommandOptions extends CallOptions {
  /** When true, a nonzero exit throws {@linkcode GuestExecError}. */
  readonly check?: boolean;
  /** Guest working directory (`limactl shell --workdir`). */
  readonly workdir?: string;
}

/** Options for {@linkcode LimaInstance.copyIn} / {@linkcode LimaInstance.copyOut}. */
export interface CopyOptions extends CallOptions {
  /** Copy directories recursively (`limactl cp -r`). */
  readonly recursive?: boolean;
}

/** Options for {@linkcode LimaInstance.copyInAsRoot}. */
export interface CopyInAsRootOptions extends CallOptions {
  /** File mode for `install -m`. @default "0600" */
  readonly mode?: string;
  /** Owner for `install -o` (root when omitted). */
  readonly owner?: string;
  /** Group for `install -g`. */
  readonly group?: string;
  /** Guest staging prefix. @default LIMA_CP_STAGING_PREFIX */
  readonly stagingPrefix?: string;
}

/** Options for {@linkcode LimaInstance.waitReady}. */
export interface WaitReadyOptions {
  /** Overall deadline. @default 120_000 */
  readonly timeoutMs?: number;
  /** Poll interval. @default 2_000 */
  readonly intervalMs?: number;
  /** Guest script that must exit 0. @default "true" */
  readonly probe?: string;
  /** Abort the wait (probes and sleeps both observe it). */
  readonly signal?: AbortSignal;
}

/** Snapshot operations (`limactl snapshot …`). qemu instances only — vz has no snapshot support; on a vz instance limactl's own error surfaces. */
export interface SnapshotOps {
  /** `limactl snapshot create <name> --tag <tag>`. */
  create(options: { readonly tag: string } & CallOptions): Promise<void>;
  /** `limactl snapshot apply <name> --tag <tag>`. */
  apply(options: { readonly tag: string } & CallOptions): Promise<void>;
  /** `limactl snapshot delete <name> --tag <tag>`. */
  delete(options: { readonly tag: string } & CallOptions): Promise<void>;
  /** `limactl snapshot list <name>` — raw table output. */
  list(options?: CallOptions): Promise<string>;
}

/**
 * A handle on one named Lima instance. Construct directly, or via
 * {@linkcode import("./limactl.ts").Limactl.instance} to share a client's
 * runner and defaults.
 */
export class LimaInstance {
  /** The Lima instance name this handle is bound to. */
  readonly name: string;
  readonly #o: ResolvedOptions;
  /** Snapshot operations for this instance. */
  readonly snapshot: SnapshotOps;

  /** Bind a handle to `name`; all options default (real runner, `"limactl"`). */
  constructor(name: string, options: LimactlOptions = {}) {
    this.name = name;
    this.#o = resolveOptions(options);
    this.snapshot = {
      create: (options) => this.#snapshotOp("create", options),
      apply: (options) => this.#snapshotOp("apply", options),
      delete: (options) => this.#snapshotOp("delete", options),
      list: async (options = {}) => {
        const result = await runChecked(
          this.#o.runner,
          this.#o.bin,
          ["snapshot", "list", this.name],
          buildRunOptions(this.#o, options),
        );
        return result.stdout;
      },
    };
  }

  /** Whether the instance exists (`limactl list -q` membership). */
  async exists(options: CallOptions = {}): Promise<boolean> {
    const result = await this.#o.runner.run(
      this.#o.bin,
      ["list", "-q"],
      buildRunOptions(this.#o, options),
    );
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .includes(this.name);
  }

  /** Typed info via `limactl list --json`, or `undefined` when absent. */
  async info(options: CallOptions = {}): Promise<InstanceInfo | undefined> {
    const result = await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["list", "--json"],
      buildRunOptions(this.#o, options),
    );
    return parseInstanceList(result.stdout).find(
      (info) => info.name === this.name,
    );
  }

  /** The instance's status, or `undefined` when absent. */
  async status(options: CallOptions = {}): Promise<InstanceStatus | undefined> {
    return (await this.info(options))?.status;
  }

  /**
   * Whether the instance reports `Running`. Probed via the cheap
   * `list --format` text form (no JSON parse for a boolean).
   */
  async isRunning(options: CallOptions = {}): Promise<boolean> {
    const result = await this.#o.runner.run(
      this.#o.bin,
      ["list", "--format", "{{.Name}}\t{{.Status}}"],
      buildRunOptions(this.#o, options),
    );
    for (const line of result.stdout.split("\n")) {
      const [name, status] = line.split("\t");
      if (name?.trim() === this.name) {
        return status?.trim().toLowerCase() === "running";
      }
    }
    return false;
  }

  /** Boot the existing instance (`limactl start <name>`; no-op when running). */
  async start(options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["start", this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Stop the instance. `force` kills the hostagent (`stop -f`) — the first rung of Broken-instance recovery. */
  async stop(
    options: { readonly force?: boolean } & CallOptions = {},
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["stop", ...(options.force === true ? ["-f"] : []), this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Delete the instance. Forced by default (`delete -f`) — matching how deletion is used in practice; pass `force: false` to let limactl refuse a running instance. */
  async delete(
    options: { readonly force?: boolean } & CallOptions = {},
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["delete", ...(options.force === false ? [] : ["-f"]), this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Restart the instance (`limactl restart <name>`). */
  async restart(options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["restart", this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Factory-reset: destroys instance data, keeps identity + config. Last-resort Broken recovery. */
  async factoryReset(options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["factory-reset", this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Protect the instance from accidental deletion (`limactl protect`). */
  async protect(options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["protect", this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /** Remove deletion protection (`limactl unprotect`). */
  async unprotect(options: CallOptions = {}): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["unprotect", this.name],
      buildRunOptions(this.#o, options),
    );
  }

  /**
   * Run a bash script in the guest:
   * `limactl shell <name> -- bash -lc "set -euo pipefail; <script>"`, with the
   * privileged variant wrapping the body as `sudo -E bash -lc '<quoted>'`.
   * Returns the raw result unless `check` throws on a nonzero exit.
   */
  async exec(
    script: string,
    options: GuestExecOptions = {},
  ): Promise<GuestExecResult> {
    const env = options.env ?? {};
    const exports = Object.entries(env)
      .map(([name, value]) => `export ${name}=${shellQuote(value)}; `)
      .join("");
    const inner = `${exports}${script}`;
    const wrapped = options.strict === false ? inner : strictWrap(inner);
    const body = options.sudo === true || options.user !== undefined
      ? sudoWrap(wrapped, {
        sudoBin: this.#o.sudoBin,
        ...(options.user === undefined ? {} : { user: options.user }),
      })
      : wrapped;
    const args = buildShellArgv(
      this.name,
      body,
      options.workdir === undefined ? {} : { workdir: options.workdir },
    );
    const result = await this.#o.runner.run(
      this.#o.bin,
      args,
      buildRunOptions(this.#o, options),
    );
    if (options.check === true && !result.success) {
      throw new GuestExecError(result, this.#o.bin, args, this.name, script);
    }
    return { ...result, instance: this.name, script };
  }

  /** Run a raw argv in the guest (`limactl shell <name> -- <argv…>`) — no bash, no wrapping. */
  async command(
    argv: readonly string[],
    options: GuestCommandOptions = {},
  ): Promise<GuestExecResult> {
    const args = [
      "shell",
      ...(options.workdir === undefined ? [] : ["--workdir", options.workdir]),
      this.name,
      "--",
      ...argv,
    ];
    const result = await this.#o.runner.run(
      this.#o.bin,
      args,
      buildRunOptions(this.#o, options),
    );
    const script = argv.join(" ");
    if (options.check === true && !result.success) {
      throw new GuestExecError(result, this.#o.bin, args, this.name, script);
    }
    return { ...result, instance: this.name, script };
  }

  /** Host→guest copy to a user-writable path: `limactl cp <local> <name>:<guest>`. */
  async copyIn(
    localPath: string,
    guestPath: string,
    options: CopyOptions = {},
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      [
        "cp",
        ...(options.recursive === true ? ["-r"] : []),
        localPath,
        `${this.name}:${guestPath}`,
      ],
      buildRunOptions(this.#o, options),
    );
  }

  /** Guest→host copy: `limactl cp <name>:<guest> <local>`. */
  async copyOut(
    guestPath: string,
    localPath: string,
    options: CopyOptions = {},
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      [
        "cp",
        ...(options.recursive === true ? ["-r"] : []),
        `${this.name}:${guestPath}`,
        localPath,
      ],
      buildRunOptions(this.#o, options),
    );
  }

  /**
   * Deliver a host file to a root-owned guest path. `limactl cp` rsyncs as
   * the unprivileged lima user, which cannot write root-owned destinations —
   * so stage into a user-writable temp path, then `sudo install` it into
   * place with the requested mode/owner/group, and remove the staging copy.
   */
  async copyInAsRoot(
    localPath: string,
    guestPath: string,
    options: CopyInAsRootOptions = {},
  ): Promise<void> {
    const staging = `${
      options.stagingPrefix ?? LIMA_CP_STAGING_PREFIX
    }${crypto.randomUUID()}`;
    await this.copyIn(localPath, staging, options);
    const install = [
      `install -m ${options.mode ?? "0600"}`,
      ...(options.owner === undefined ? [] : [`-o ${options.owner}`]),
      ...(options.group === undefined ? [] : [`-g ${options.group}`]),
      shellQuote(staging),
      shellQuote(guestPath),
    ].join(" ");
    await this.exec(
      `${install} && rm -f ${shellQuote(staging)}`,
      { check: true, sudo: true, ...callOnly(options) },
    );
  }

  /**
   * Poll a guest probe until it exits 0. Fails fast with
   * {@linkcode InstanceBrokenError} when the instance turns `Broken`;
   * {@linkcode WaitTimeoutError} on deadline. The post-host-reboot
   * "Running but ssh not yet answering" primitive.
   */
  async waitReady(options: WaitReadyOptions = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const intervalMs = options.intervalMs ?? 2_000;
    const probe = options.probe ?? "true";
    const deadline = Date.now() + timeoutMs;
    let last: CommandResult | undefined;
    while (true) {
      // Bound each probe by the remaining budget so a hung limactl call
      // cannot outlive the documented deadline.
      const call: CallOptions = {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: Math.max(1, deadline - Date.now()),
      };
      try {
        const info = await this.info(call);
        if (info?.status === "Broken") {
          throw new InstanceBrokenError(this.name, info.errors);
        }
        last = await this.exec(probe, call);
      } catch (error) {
        if (
          error instanceof CommandAbortedError &&
          Date.now() >= deadline &&
          options.signal?.aborted !== true
        ) {
          throw new WaitTimeoutError(this.name, timeoutMs, last);
        }
        throw error;
      }
      if (last.success) return;
      if (Date.now() + intervalMs > deadline) {
        throw new WaitTimeoutError(this.name, timeoutMs, last);
      }
      await sleep(intervalMs, options.signal);
    }
  }

  async #snapshotOp(
    op: "create" | "apply" | "delete",
    options: { readonly tag: string } & CallOptions,
  ): Promise<void> {
    await runChecked(
      this.#o.runner,
      this.#o.bin,
      ["snapshot", op, this.name, "--tag", options.tag],
      buildRunOptions(this.#o, options),
    );
  }
}

function callOnly(options: CallOptions): CallOptions {
  return {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
