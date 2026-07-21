/**
 * Typed instance status from `limactl list --json`.
 *
 * `limactl list --json` emits one JSON object **per line** (JSONL, not an
 * array). {@linkcode parseInstanceList} splits lines and hand-narrows each —
 * a mistyped known field degrades to `undefined`, unknown fields survive in
 * {@linkcode InstanceInfo.raw}, and an unparseable line throws
 * {@linkcode import("./errors.ts").LimaOutputError} (loud beats silent).
 *
 * @module
 */

import { LimaOutputError } from "./errors.ts";

/**
 * Instance status as reported by limactl. An open union: the known states are
 * typed, future states flow through as plain strings.
 */
export type InstanceStatus =
  | "Running"
  | "Stopped"
  | "Broken"
  | "Unknown"
  // deno-lint-ignore ban-types
  | (string & {});

/** One instance, as reported by `limactl list --json`. */
export interface InstanceInfo {
  /** The instance name. */
  readonly name: string;
  /** The reported status (open union). */
  readonly status: InstanceStatus;
  /** The instance directory (under `~/.lima`). */
  readonly dir?: string;
  /** `"qemu" | "vz" | "wsl2"` | future driver names. */
  readonly vmType?: string;
  /** Guest CPU architecture. */
  readonly arch?: string;
  /** vCPU count. */
  readonly cpus?: number;
  /** Memory in bytes. */
  readonly memory?: number;
  /** Disk size in bytes. */
  readonly disk?: number;
  /** Host-side ssh port. */
  readonly sshLocalPort?: number;
  /** Host-side ssh address. */
  readonly sshAddress?: string;
  /** Path to the instance's generated ssh config. */
  readonly sshConfigFile?: string;
  /** The hostagent process id, when running. */
  readonly hostAgentPid?: number;
  /** The VM driver process id, when running. */
  readonly driverPid?: number;
  /** Diagnostics when the instance is `Broken`; empty otherwise. */
  readonly errors: readonly string[];
  /** Whether the instance is protected from deletion. */
  readonly protected?: boolean;
  /** The full parsed JSON object — nothing dropped. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/** Parse one `limactl list --json` line into an {@linkcode InstanceInfo}. */
export function parseInstanceInfo(line: string): InstanceInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new LimaOutputError("unparseable limactl list --json line", line);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LimaOutputError(
      "limactl list --json line is not an object",
      line,
    );
  }
  const raw = parsed as Record<string, unknown>;
  const name = asString(raw.name);
  if (name === undefined) {
    throw new LimaOutputError("limactl list --json line has no name", line);
  }
  return {
    name,
    status: asString(raw.status) ?? "Unknown",
    ...optional("dir", asString(raw.dir)),
    ...optional("vmType", asString(raw.vmType)),
    ...optional("arch", asString(raw.arch)),
    ...optional("cpus", asNumber(raw.cpus)),
    ...optional("memory", asNumber(raw.memory)),
    ...optional("disk", asNumber(raw.disk)),
    ...optional("sshLocalPort", asNumber(raw.sshLocalPort)),
    ...optional("sshAddress", asString(raw.sshAddress)),
    ...optional("sshConfigFile", asString(raw.sshConfigFile)),
    ...optional("hostAgentPid", asNumber(raw.hostAgentPID)),
    ...optional("driverPid", asNumber(raw.driverPID)),
    errors: asStringArray(raw.errors),
    ...optional("protected", asBoolean(raw.protected)),
    raw,
  };
}

/** Parse a whole `limactl list --json` stdout (JSONL; blank lines skipped). */
export function parseInstanceList(stdout: string): InstanceInfo[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseInstanceInfo);
}

function optional<K extends string, V>(
  key: K,
  value: V | undefined,
): Partial<Record<K, V>> {
  return value === undefined ? {} : { [key]: value } as Record<K, V>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : entry === null
        ? undefined
        : String(entry)
    )
    .filter((entry): entry is string => entry !== undefined);
}
