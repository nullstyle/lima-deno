/**
 * `@nullstyle/lima` — programmatic management of Lima VMs
 * ([lima-vm.io](https://lima-vm.io)) for Deno.
 *
 * Everything drives the `limactl` CLI through an injectable subprocess seam
 * ({@linkcode CommandRunner}), so downstream code is testable with the
 * recording fake on the `./testing` subpath — no VM, no `limactl` binary.
 * The `./config` subpath renders typed Lima templates deterministically
 * (byte-stable output you can commit and drift-test).
 *
 * @example Create a VM, run a command, copy a file out, clean up
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
 *   const uname = await vm.exec("uname -a", { check: true });
 *   console.log(uname.stdout.trim());
 *   await vm.exec("echo hello > /tmp/greeting", { check: true });
 *   await vm.copyOut("/tmp/greeting", "./greeting.txt");
 * } finally {
 *   await vm.delete();
 * }
 * ```
 *
 * @module
 */

// The subprocess seam:
export {
  CommandAbortedError,
  CommandError,
  type CommandResult,
  type CommandRunner,
  DenoCommandRunner,
  type DenoCommandRunnerOptions,
  MAX_CAPTURE_BYTES,
  runChecked,
  type RunOptions,
} from "./src/runner.ts";

// Shell helpers:
export {
  buildShellArgv,
  type ShellArgvOptions,
  shellQuote,
  strictWrap,
  sudoWrap,
  type SudoWrapOptions,
} from "./src/shell.ts";

// Version & compatibility:
export {
  compareLimactlVersions,
  LIMA_COMPAT,
  type LimactlVersion,
  parseLimactlVersion,
} from "./src/version.ts";

// Typed status:
export {
  type InstanceInfo,
  type InstanceStatus,
  parseInstanceInfo,
  parseInstanceList,
} from "./src/status.ts";

// Errors:
export {
  GuestExecError,
  InstanceBrokenError,
  LimaOutputError,
  LimaVersionError,
  WaitTimeoutError,
} from "./src/errors.ts";

// The client & handle:
export { type CallOptions, type LimactlOptions } from "./src/options.ts";
export {
  type CreateOptions,
  type CreateSource,
  type DiskInfo,
  Limactl,
} from "./src/limactl.ts";
export {
  type CopyInAsRootOptions,
  type CopyOptions,
  type GuestCommandOptions,
  type GuestExecOptions,
  type GuestExecResult,
  LIMA_CP_STAGING_PREFIX,
  LimaInstance,
  type SnapshotOps,
  type WaitReadyOptions,
} from "./src/instance.ts";

// Template config & rendering (also on the "./config" subpath):
export {
  type AdditionalDisk,
  CONFIG_KEY_ORDER,
  type ImageSpec,
  type LimaConfig,
  type MountSpec,
  type PortForward,
  type ProbeSpec,
  type ProvisionScript,
  renderLimaYaml,
  type RenderOptions,
} from "./src/config/mod.ts";

// Image building & capture (also on the "./image" subpath):
export {
  buildImage,
  type BuildStep,
  type BuiltImage,
  captureImage,
  type CaptureImageOptions,
  configFromImage,
  DEFAULT_SEAL_SCRIPT,
  diskFloorGiB,
  formatImageEvent,
  hostArch,
  type ImageBase,
  type ImageBaseImage,
  ImageBuildError,
  type ImageBuildOptions,
  type ImageBuildPhase,
  type ImageBuildSpec,
  ImageCaptureError,
  ImageDiskFloorError,
  type ImageEvent,
  type ImageFormat,
  ImageStore,
  ImageStoreError,
  type ImageStoreListOptions,
  type ImageStoreOptions,
  type ImageStorePutOptions,
  type LimaArch,
  type QemuImgCallOptions,
  type QemuImgLike,
  type QemuImgLikeConvertOptions,
  type QemuImgLikeInfo,
  type ResolvedImageBase,
  resolveImageBase,
  sha256File,
  type Sha256FileOptions,
  type StoredImage,
  toImageSpec,
} from "./src/image/mod.ts";

// Throwaway instances:
export { withInstance, type WithInstanceOptions } from "./src/ephemeral.ts";

// Convenience re-exports from the qemu-img driver dependency (the class
// itself lives in `@nullstyle/qemu-img`; option types here reference it only
// structurally, via QemuImgLike):
export { QemuImgMissingError, QemuImgOutputError } from "@nullstyle/qemu-img";
