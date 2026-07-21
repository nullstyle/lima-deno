/**
 * Shared client/handle option types and the run-option composition helper.
 *
 * @module
 */

import {
  type CommandRunner,
  DenoCommandRunner,
  type RunOptions,
} from "./runner.ts";

/** Options shared by {@linkcode import("./limactl.ts").Limactl} and {@linkcode import("./instance.ts").LimaInstance}. */
export interface LimactlOptions {
  /** The subprocess seam. @default new DenoCommandRunner() */
  readonly runner?: CommandRunner;
  /** `limactl` binary. @default "limactl" */
  readonly bin?: string;
  /** `sudo` binary for privileged guest steps. @default "sudo" */
  readonly sudoBin?: string;
  /** Default abort signal composed into every run. */
  readonly signal?: AbortSignal;
  /** Default per-command timeout in milliseconds. */
  readonly timeoutMs?: number;
}

/** Per-call cancellation overrides accepted by long-running verbs. */
export interface CallOptions {
  /** Abort this call (composed with the client-default signal). */
  readonly signal?: AbortSignal;
  /** Deadline for this call; overrides the client default. */
  readonly timeoutMs?: number;
}

/** {@linkcode LimactlOptions} with defaults applied. */
export interface ResolvedOptions {
  readonly runner: CommandRunner;
  readonly bin: string;
  readonly sudoBin: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** Apply defaults to a {@linkcode LimactlOptions}. */
export function resolveOptions(options: LimactlOptions = {}): ResolvedOptions {
  return {
    runner: options.runner ?? new DenoCommandRunner(),
    bin: options.bin ?? "limactl",
    sudoBin: options.sudoBin ?? "sudo",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
}

/**
 * Compose client-default and per-call cancellation into {@linkcode RunOptions}.
 * Both signals abort the run when either fires; a per-call timeout overrides
 * the client default.
 */
export function buildRunOptions(
  defaults: ResolvedOptions,
  call: CallOptions = {},
  extra: Pick<RunOptions, "stdin" | "uncapped"> = {},
): RunOptions {
  const signals = [defaults.signal, call.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const signal = signals.length === 0
    ? undefined
    : signals.length === 1
    ? signals[0]
    : AbortSignal.any(signals);
  const timeoutMs = call.timeoutMs ?? defaults.timeoutMs;
  return {
    ...extra,
    ...(signal === undefined ? {} : { signal }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}
