/**
 * The pure template layer: typed Lima configuration and its deterministic
 * YAML renderer. This subpath has zero runtime dependencies and needs zero
 * permissions — render a template anywhere, write it (or pipe it to
 * `limactl start -`) from the caller.
 *
 * @example Render a locked-down vz template
 * ```ts
 * import { renderLimaYaml } from "@nullstyle/lima/config";
 *
 * const yaml = renderLimaYaml({
 *   base: "template://ubuntu-24.04",
 *   vmType: "vz",
 *   nestedVirtualization: true,
 *   cpus: 4,
 *   memory: "6GiB",
 *   disk: "40GiB",
 *   mounts: [],
 *   portForwards: [{ guestPort: 8080, hostIP: "127.0.0.1", hostPort: 8080 }],
 * });
 * ```
 *
 * @module
 */

// Config types:
export type {
  AdditionalDisk,
  ImageSpec,
  LimaConfig,
  MountSpec,
  PortForward,
  ProbeSpec,
  ProvisionScript,
} from "./types.ts";

// Rendering:
export {
  CONFIG_KEY_ORDER,
  renderLimaYaml,
  type RenderOptions,
} from "./render.ts";
