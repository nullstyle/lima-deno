/**
 * Typed Lima instance configuration (`lima.yaml`).
 *
 * Every key mirrors a real key in Lima's template schema. `comment?` fields
 * are **render-only metadata**: they exist so generated templates can be
 * self-documenting artifacts, and never affect Lima's behavior. Anything not
 * typed here is expressible via {@linkcode LimaConfig.raw}.
 *
 * @module
 */

/** One entry in `images:`. */
export interface ImageSpec {
  /** Image URL or file path. */
  readonly location: string;
  /** Image architecture (e.g. `"x86_64"`, `"aarch64"`). */
  readonly arch?: string;
  /** Content digest pin (e.g. `"sha256:…"`). */
  readonly digest?: string;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/** One entry in `mounts:`. */
export interface MountSpec {
  /** Host path to mount. */
  readonly location: string;
  /** Guest mount point; defaults to `location` when omitted. */
  readonly mountPoint?: string;
  /** Whether the guest may write to the mount. */
  readonly writable?: boolean;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/** One entry in `portForwards:`. */
export interface PortForward {
  /** Guest bind address to match. */
  readonly guestIP?: string;
  /** Single guest port to forward. */
  readonly guestPort?: number;
  /** Inclusive `[start, end]` guest port range. */
  readonly guestPortRange?: readonly [number, number];
  /** Guest Unix socket to forward. */
  readonly guestSocket?: string;
  /** Host bind address. */
  readonly hostIP?: string;
  /** Host port; defaults to the guest port. */
  readonly hostPort?: number;
  /** Inclusive `[start, end]` host port range. */
  readonly hostPortRange?: readonly [number, number];
  /** Host Unix socket. */
  readonly hostSocket?: string;
  /** Protocol to match. */
  readonly proto?: "tcp" | "udp";
  /** Forward host→guest instead of guest→host. */
  readonly reverse?: boolean;
  /** Exclude matching ports from forwarding. */
  readonly ignore?: boolean;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/** One entry in `provision:`. */
export interface ProvisionScript {
  /** When and as whom the script runs. */
  readonly mode: "system" | "user" | "boot" | "dependency";
  /** The script body (rendered as a literal block). */
  readonly script: string;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/** One entry in `probes:`. */
export interface ProbeSpec {
  /** Probe kind; Lima currently defines `"readiness"`. */
  readonly mode?: "readiness";
  /** Human-readable description shown while waiting. */
  readonly description?: string;
  /** The probe script (rendered as a literal block; must exit 0 when ready). */
  readonly script: string;
  /** Hint printed when the probe fails. */
  readonly hint?: string;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/** One entry in `additionalDisks:`. */
export interface AdditionalDisk {
  /** The disk name (created via `limactl disk create`). */
  readonly name: string;
  /** Format the disk on first attach. */
  readonly format?: boolean;
  /** Filesystem to format with (e.g. `"ext4"`). */
  readonly fsType?: string;
  /** Render-only comment above this entry. */
  readonly comment?: string;
}

/**
 * A typed Lima instance configuration. All keys optional; omitted keys are
 * not rendered (Lima's own defaults apply). The `raw` escape hatch is a
 * verbatim YAML block appended after every typed key, for anything not (yet)
 * typed here — `networks`, `dns`, `firmware`, `user`, ….
 */
export interface LimaConfig {
  /** Minimum Lima version this template requires. */
  readonly minimumLimaVersion?: string;
  /** Base template(s): `template://…`, `https://…`, or a file path. */
  readonly base?: string | readonly string[];
  /** VM driver. */
  readonly vmType?: "qemu" | "vz";
  /** Guest OS; Lima currently defines `"Linux"`. */
  readonly os?: string;
  /** Guest architecture (e.g. `"x86_64"`, `"aarch64"`). */
  readonly arch?: string;
  /** Guest images (usually supplied by `base`). */
  readonly images?: readonly ImageSpec[];
  /** Requires vmType `vz` (Apple Silicon M3+, macOS 15+). */
  readonly nestedVirtualization?: boolean;
  /** Rosetta (x86_64 emulation on Apple Silicon, vz only). */
  readonly rosetta?: { readonly enabled?: boolean; readonly binfmt?: boolean };
  /** vCPUs assigned to the VM. */
  readonly cpus?: number;
  /** Lima size grammar, e.g. `"6GiB"`. */
  readonly memory?: string;
  /** Lima size grammar, e.g. `"40GiB"`. */
  readonly disk?: string;
  /** Extra disks to attach (see `limactl disk`). */
  readonly additionalDisks?: readonly AdditionalDisk[];
  /** `[]` renders `mounts: []` (no host mounts) — distinct from unset. */
  readonly mounts?: readonly MountSpec[];
  /** Mount driver. */
  readonly mountType?: "reverse-sshfs" | "9p" | "virtiofs";
  /** SSH settings. */
  readonly ssh?: {
    readonly localPort?: number;
    readonly loadDotSSHPubKeys?: boolean;
    readonly forwardAgent?: boolean;
  };
  /** containerd runtimes inside the guest. */
  readonly containerd?: { readonly system?: boolean; readonly user?: boolean };
  /** Provisioning scripts, run in order at boot. */
  readonly provision?: readonly ProvisionScript[];
  /** Readiness probes `limactl start` waits on. */
  readonly probes?: readonly ProbeSpec[];
  /** Static port forwards. */
  readonly portForwards?: readonly PortForward[];
  /** Guest environment; rendered in insertion order (caller-deterministic). */
  readonly env?: Readonly<Record<string, string>>;
  /** Verbatim YAML appended after all typed keys. Must be valid Lima YAML. */
  readonly raw?: string;
}
