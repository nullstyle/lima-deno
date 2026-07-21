/**
 * Typed errors raised by the library beyond the runner-level
 * {@linkcode import("./runner.ts").CommandError}.
 *
 * @module
 */

import { CommandError, type CommandResult } from "./runner.ts";
import type { LimactlVersion } from "./version.ts";

/** A guest script failed a `check: true` contract. */
export class GuestExecError extends CommandError {
  /** The Lima instance the script ran in. */
  readonly instance: string;
  /** The script (before strict/sudo wrapping) that failed. */
  readonly script: string;

  /** Build the error from a failed guest-exec result. */
  constructor(
    result: CommandResult,
    bin: string,
    args: readonly string[],
    instance: string,
    script: string,
  ) {
    super(result, bin, args);
    this.name = "GuestExecError";
    this.instance = instance;
    this.script = script;
    this.message = `guest script failed in ${instance} (exit ${result.code})${
      result.stderr.length > 0 ? `\n${result.stderr.trim()}` : ""
    }`;
  }
}

/** `limactl` is missing, unrunnable, or below the required version floor. */
export class LimaVersionError extends Error {
  /** The version found, when limactl ran but was too old. */
  readonly found?: LimactlVersion;
  /** The minimum acceptable version. */
  readonly minimum: string;

  /** Build the error; omit `found` when limactl is missing entirely. */
  constructor(minimum: string, found?: LimactlVersion) {
    super(
      found === undefined
        ? `limactl not found (need >= ${minimum}); install lima (brew install lima)`
        : `limactl ${found.raw} is below the required minimum ${minimum}`,
    );
    this.name = "LimaVersionError";
    this.minimum = minimum;
    if (found !== undefined) this.found = found;
  }
}

/** `limactl` produced output the library could not interpret. */
export class LimaOutputError extends Error {
  /** The offending output. */
  readonly output: string;

  /** Build the error; the message embeds a truncated copy of the output. */
  constructor(message: string, output: string) {
    super(`${message}: ${JSON.stringify(truncate(output, 200))}`);
    this.name = "LimaOutputError";
    this.output = output;
  }
}

/** `waitReady` exceeded its deadline. */
export class WaitTimeoutError extends Error {
  /** The instance that never became ready. */
  readonly instance: string;
  /** The last probe result, for diagnosis. */
  readonly lastResult?: CommandResult;

  /** Build the error carrying the deadline and the last probe result. */
  constructor(instance: string, timeoutMs: number, lastResult?: CommandResult) {
    super(`instance ${instance} not ready after ${timeoutMs}ms`);
    this.name = "WaitTimeoutError";
    this.instance = instance;
    if (lastResult !== undefined) this.lastResult = lastResult;
  }
}

/** The instance reports `Broken`; carries limactl's own diagnostics. */
export class InstanceBrokenError extends Error {
  /** The broken instance. */
  readonly instance: string;
  /** limactl's error strings for the broken instance. */
  readonly errors: readonly string[];

  /** Build the error from limactl's own diagnostics. */
  constructor(instance: string, errors: readonly string[]) {
    super(
      `instance ${instance} is Broken${
        errors.length > 0 ? `: ${errors.join("; ")}` : ""
      }`,
    );
    this.name = "InstanceBrokenError";
    this.instance = instance;
    this.errors = [...errors];
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
