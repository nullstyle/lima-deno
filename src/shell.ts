/**
 * Shell quoting and script-wrapping helpers, plus the single source of truth
 * for the `limactl shell` argv shape.
 *
 * {@linkcode buildShellArgv} is exported so the library, the `./testing` fake,
 * and downstream test suites all derive guest-exec argv (and its inverse, the
 * fake's unwrapping) from one grammar instead of hand-rolled regexes.
 *
 * @module
 */

/** Single-quote a string for safe embedding in a bash command line. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefix a bash body so it runs with a predictable shell contract:
 * `set -euo pipefail` (fail fast, unset vars are errors, pipeline failures
 * propagate).
 */
export function strictWrap(script: string): string {
  return `set -euo pipefail; ${script}`;
}

/** Options for {@linkcode sudoWrap}. */
export interface SudoWrapOptions {
  /** `sudo` binary. @default "sudo" */
  readonly sudoBin?: string;
  /** Run as this user (`sudo -u USER`); root when omitted. */
  readonly user?: string;
}

/**
 * Wrap a script so it runs privileged: `sudo -E [-u USER] bash -lc '<quoted>'`.
 * `-E` preserves the environment; the script is {@linkcode shellQuote}d.
 */
export function sudoWrap(
  script: string,
  options: SudoWrapOptions = {},
): string {
  const sudo = options.sudoBin ?? "sudo";
  const user = options.user === undefined ? "" : ` -u ${options.user}`;
  return `${sudo} -E${user} bash -lc ${shellQuote(script)}`;
}

/** Options for {@linkcode buildShellArgv}. */
export interface ShellArgvOptions {
  /** Guest working directory (`limactl shell --workdir`). */
  readonly workdir?: string;
}

/**
 * Build the exact `limactl` argv (without the binary itself) that runs a bash
 * body in the named instance: `shell [--workdir D] <name> -- bash -lc <body>`.
 */
export function buildShellArgv(
  instance: string,
  body: string,
  options: ShellArgvOptions = {},
): readonly string[] {
  return [
    "shell",
    ...(options.workdir === undefined ? [] : ["--workdir", options.workdir]),
    instance,
    "--",
    "bash",
    "-lc",
    body,
  ];
}
