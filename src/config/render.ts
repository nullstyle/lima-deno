/**
 * Deterministic, dependency-free rendering of a {@linkcode LimaConfig} to
 * Lima YAML.
 *
 * The byte output is a **contract**: the same config + options produce the
 * same bytes, stable under semver within a major version, so downstream
 * projects can commit rendered templates and pin them with byte-drift tests.
 * That is why this is hand-rendered and not a YAML serializer — serializer
 * output style is not contractually stable across versions, and serializers
 * cannot emit comments.
 *
 * Determinism rules (test-pinned):
 * - Top-level keys emit in {@linkcode CONFIG_KEY_ORDER}; omitted keys are not
 *   rendered; `raw` is always last.
 * - 2-space indent; list items as `  - `; ranges in flow style `[a, b]`.
 * - Strings render plain iff they match `^[A-Za-z][A-Za-z0-9_.+:/@~-]*$` and
 *   are not a YAML reserved word; otherwise double-quoted (JSON escaping).
 * - `provision`/`probes` scripts render as literal block scalars (`script: |`).
 * - `env` keys emit in insertion order (caller-controlled).
 *
 * @module
 */

import type {
  AdditionalDisk,
  ImageSpec,
  LimaConfig,
  MountSpec,
  PortForward,
  ProbeSpec,
  ProvisionScript,
} from "./types.ts";

/** The fixed top-level key emission order. */
export const CONFIG_KEY_ORDER: readonly (keyof LimaConfig)[] = [
  "minimumLimaVersion",
  "base",
  "vmType",
  "nestedVirtualization",
  "rosetta",
  "os",
  "arch",
  "images",
  "cpus",
  "memory",
  "disk",
  "additionalDisks",
  "mounts",
  "mountType",
  "ssh",
  "containerd",
  "provision",
  "probes",
  "portForwards",
  "env",
  "raw",
];

/** Options for {@linkcode renderLimaYaml}. */
export interface RenderOptions {
  /** Comment block emitted above the document (lines prefixed `# `). */
  readonly header?: string;
  /**
   * Comment emitted above a top-level key (prefixed `# `), preceded by a
   * blank line. An **empty string** emits the blank separator line only —
   * use it to group keys without commenting them.
   */
  readonly comments?: Partial<Record<keyof LimaConfig, string>>;
}

/** Render a {@linkcode LimaConfig} to deterministic Lima YAML. */
export function renderLimaYaml(
  config: LimaConfig,
  options: RenderOptions = {},
): string {
  const lines: string[] = [];
  if (options.header !== undefined) {
    pushComment(lines, options.header, "");
    lines.push("");
  }
  let first = true;
  for (const key of CONFIG_KEY_ORDER) {
    const value = config[key];
    if (value === undefined) continue;
    const comment = options.comments?.[key];
    if (comment !== undefined && !first) lines.push("");
    if (comment !== undefined && comment.length > 0) {
      pushComment(lines, comment, "");
    }
    renderKey(lines, key, config);
    first = false;
  }
  return lines.join("\n") + "\n";
}

function renderKey(
  lines: string[],
  key: keyof LimaConfig,
  config: LimaConfig,
): void {
  switch (key) {
    case "minimumLimaVersion":
      lines.push(`minimumLimaVersion: ${scalar(config.minimumLimaVersion!)}`);
      break;
    case "base": {
      const base = config.base!;
      if (typeof base === "string") {
        lines.push(`base: ${scalar(base)}`);
      } else {
        lines.push("base:");
        for (const entry of base) lines.push(`  - ${scalar(entry)}`);
      }
      break;
    }
    case "vmType":
      lines.push(`vmType: ${scalar(config.vmType!)}`);
      break;
    case "nestedVirtualization":
      lines.push(`nestedVirtualization: ${config.nestedVirtualization}`);
      break;
    case "rosetta":
      renderMap(lines, "rosetta", config.rosetta!);
      break;
    case "os":
      lines.push(`os: ${scalar(config.os!)}`);
      break;
    case "arch":
      lines.push(`arch: ${scalar(config.arch!)}`);
      break;
    case "images":
      renderEntryList(lines, "images", config.images!, imageFields);
      break;
    case "cpus":
      lines.push(`cpus: ${config.cpus}`);
      break;
    case "memory":
      lines.push(`memory: ${scalar(config.memory!)}`);
      break;
    case "disk":
      lines.push(`disk: ${scalar(config.disk!)}`);
      break;
    case "additionalDisks":
      renderEntryList(
        lines,
        "additionalDisks",
        config.additionalDisks!,
        diskFields,
      );
      break;
    case "mounts": {
      const mounts = config.mounts!;
      if (mounts.length === 0) {
        lines.push("mounts: []");
      } else {
        renderEntryList(lines, "mounts", mounts, mountFields);
      }
      break;
    }
    case "mountType":
      lines.push(`mountType: ${scalar(config.mountType!)}`);
      break;
    case "ssh":
      renderMap(lines, "ssh", config.ssh!);
      break;
    case "containerd":
      renderMap(lines, "containerd", config.containerd!);
      break;
    case "provision":
      renderEntryList(lines, "provision", config.provision!, provisionFields);
      break;
    case "probes":
      renderEntryList(lines, "probes", config.probes!, probeFields);
      break;
    case "portForwards":
      renderEntryList(
        lines,
        "portForwards",
        config.portForwards!,
        forwardFields,
      );
      break;
    case "env": {
      lines.push("env:");
      for (const [name, value] of Object.entries(config.env!)) {
        lines.push(`  ${name}: ${scalar(value)}`);
      }
      break;
    }
    case "raw": {
      const raw = config.raw!;
      for (const line of trimTrailingNewlines(raw).split("\n")) {
        lines.push(line);
      }
      break;
    }
  }
}

/** `field: value` pairs for one list entry, in fixed order. */
type FieldRenderer<T> = (entry: T) => readonly string[];

function renderEntryList<T extends { readonly comment?: string }>(
  lines: string[],
  key: string,
  entries: readonly T[],
  fields: FieldRenderer<T>,
): void {
  lines.push(`${key}:`);
  for (const entry of entries) {
    if (entry.comment !== undefined) pushComment(lines, entry.comment, "  ");
    const rendered = fields(entry);
    rendered.forEach((field, index) => {
      lines.push(
        index === 0 ? `  - ${field}` : field.length === 0 ? "" : `    ${field}`,
      );
    });
  }
}

const imageFields: FieldRenderer<ImageSpec> = (image) => [
  `location: ${scalar(image.location)}`,
  ...(image.arch === undefined ? [] : [`arch: ${scalar(image.arch)}`]),
  ...(image.digest === undefined ? [] : [`digest: ${scalar(image.digest)}`]),
];

const diskFields: FieldRenderer<AdditionalDisk> = (disk) => [
  `name: ${scalar(disk.name)}`,
  ...(disk.format === undefined ? [] : [`format: ${disk.format}`]),
  ...(disk.fsType === undefined ? [] : [`fsType: ${scalar(disk.fsType)}`]),
];

const mountFields: FieldRenderer<MountSpec> = (mount) => [
  `location: ${scalar(mount.location)}`,
  ...(mount.mountPoint === undefined
    ? []
    : [`mountPoint: ${scalar(mount.mountPoint)}`]),
  ...(mount.writable === undefined ? [] : [`writable: ${mount.writable}`]),
];

const provisionFields: FieldRenderer<ProvisionScript> = (provision) => [
  `mode: ${scalar(provision.mode)}`,
  ...blockScalar("script", provision.script),
];

const probeFields: FieldRenderer<ProbeSpec> = (probe) => [
  ...(probe.mode === undefined ? [] : [`mode: ${scalar(probe.mode)}`]),
  ...(probe.description === undefined
    ? []
    : [`description: ${scalar(probe.description)}`]),
  ...blockScalar("script", probe.script),
  ...(probe.hint === undefined ? [] : [`hint: ${scalar(probe.hint)}`]),
];

const forwardFields: FieldRenderer<PortForward> = (forward) => [
  ...(forward.guestIP === undefined
    ? []
    : [`guestIP: ${scalar(forward.guestIP)}`]),
  ...(forward.guestPort === undefined
    ? []
    : [`guestPort: ${forward.guestPort}`]),
  ...(forward.guestPortRange === undefined
    ? []
    : [`guestPortRange: ${range(forward.guestPortRange)}`]),
  ...(forward.guestSocket === undefined
    ? []
    : [`guestSocket: ${scalar(forward.guestSocket)}`]),
  ...(forward.hostIP === undefined
    ? []
    : [`hostIP: ${scalar(forward.hostIP)}`]),
  ...(forward.hostPort === undefined ? [] : [`hostPort: ${forward.hostPort}`]),
  ...(forward.hostPortRange === undefined
    ? []
    : [`hostPortRange: ${range(forward.hostPortRange)}`]),
  ...(forward.hostSocket === undefined
    ? []
    : [`hostSocket: ${scalar(forward.hostSocket)}`]),
  ...(forward.proto === undefined ? [] : [`proto: ${scalar(forward.proto)}`]),
  ...(forward.reverse === undefined ? [] : [`reverse: ${forward.reverse}`]),
  ...(forward.ignore === undefined ? [] : [`ignore: ${forward.ignore}`]),
];

/** `script: |` + indented literal block lines (entry-field indent + 2). */
function blockScalar(key: string, script: string): readonly string[] {
  const body = trimTrailingNewlines(script).split("\n");
  return [
    `${key}: |`,
    ...body.map((line) => (line.length === 0 ? "" : `  ${line}`)),
  ];
}

function renderMap(
  lines: string[],
  key: string,
  map: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  lines.push(`${key}:`);
  for (const [name, value] of Object.entries(map)) {
    if (value === undefined) continue;
    lines.push(
      `  ${name}: ${typeof value === "string" ? scalar(value) : value}`,
    );
  }
}

function range(pair: readonly [number, number]): string {
  return `[${pair[0]}, ${pair[1]}]`;
}

const PLAIN_SCALAR = /^[A-Za-z][A-Za-z0-9_.+:/@~-]*$/;
const RESERVED = new Set(["true", "false", "null", "yes", "no", "on", "off"]);

/**
 * Render a string scalar: plain iff it is unambiguous, double-quoted (JSON
 * escaping — a valid subset of YAML double-quote style) otherwise.
 */
function scalar(value: string): string {
  if (PLAIN_SCALAR.test(value) && !RESERVED.has(value.toLowerCase())) {
    return value;
  }
  return JSON.stringify(value);
}

function pushComment(lines: string[], comment: string, indent: string): void {
  for (const line of trimTrailingNewlines(comment).split("\n")) {
    lines.push(line.length === 0 ? `${indent}#` : `${indent}# ${line}`);
  }
}

function trimTrailingNewlines(value: string): string {
  return value.replace(/\n+$/, "");
}
