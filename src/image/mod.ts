/**
 * Custom Lima image building: capture a provisioned VM's disk into a
 * reusable image, orchestrate whole builds declaratively, and catalog the
 * results.
 *
 * Layers, à la carte:
 * - primitives — {@linkcode sha256File}, {@linkcode captureImage},
 *   {@linkcode toImageSpec}/{@linkcode configFromImage}/{@linkcode hostArch};
 * - the orchestrator — {@linkcode buildImage} (create → provision → seal →
 *   capture → cleanup), with {@linkcode DEFAULT_SEAL_SCRIPT};
 * - the catalog — {@linkcode ImageStore}.
 *
 * Host requirements: `qemu-img` (from `brew install qemu`) is needed only to
 * BUILD qcow2 images (and to convert qcow2-sourced disks to raw). Raw
 * capture from a raw (vz) disk clones with `cp` and needs nothing installed;
 * consumers booting a built image never need qemu-img — Lima reads qcow2
 * natively (zlib compression only, which is what this module emits).
 *
 * @example Build once, boot pre-provisioned VMs from the result
 * ```ts
 * import { buildImage, configFromImage, Limactl } from "@nullstyle/lima";
 *
 * const lima = new Limactl();
 * const image = await buildImage(lima, {
 *   base: { template: "ubuntu-24.04" },
 *   outputPath: "./dev-base.qcow2",
 *   steps: [
 *     { run: "apt-get update && apt-get install -y build-essential", sudo: true },
 *   ],
 * });
 * const vm = await lima.create("dev1", {
 *   config: configFromImage(image, { disk: "20GiB", mounts: [] }),
 * });
 * await vm.waitReady(); // boots with the toolchain already baked in
 * ```
 *
 * @module
 */

export type {
  BuiltImage,
  ImageBuildPhase,
  ImageEvent,
  ImageFormat,
} from "./types.ts";
export {
  ImageBuildError,
  ImageCaptureError,
  ImageDiskFloorError,
  ImageStoreError,
} from "./errors.ts";
export { formatImageEvent } from "./format.ts";
export { sha256File, type Sha256FileOptions } from "./digest.ts";
export type {
  QemuImgCallOptions,
  QemuImgLike,
  QemuImgLikeConvertOptions,
  QemuImgLikeInfo,
} from "./qemu_img_like.ts";
export { captureImage, type CaptureImageOptions } from "./capture.ts";
export {
  configFromImage,
  diskFloorGiB,
  hostArch,
  type LimaArch,
  toImageSpec,
} from "./spec.ts";
export {
  buildImage,
  type BuildStep,
  DEFAULT_SEAL_SCRIPT,
  type ImageBase,
  type ImageBaseImage,
  type ImageBuildOptions,
  type ImageBuildSpec,
  type ResolvedImageBase,
  resolveImageBase,
} from "./build.ts";
export {
  ImageStore,
  type ImageStoreListOptions,
  type ImageStoreOptions,
  type ImageStorePutOptions,
  type StoredImage,
} from "./store.ts";
