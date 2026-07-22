/**
 * Helpers that turn a {@linkcode BuiltImage} into Lima configuration.
 *
 * @module
 */

import type { ImageSpec, LimaConfig } from "../config/types.ts";
import type { BuiltImage } from "./types.ts";

/**
 * A Lima guest architecture. An open union: the two common arches are typed,
 * everything else limactl accepts (`riscv64`, `armv7l`, `s390x`, `ppc64le`)
 * flows through as a plain string.
 */
export type LimaArch =
  | "x86_64"
  | "aarch64"
  // deno-lint-ignore ban-types
  | (string & {});

/** The host's architecture as a Lima arch string (`Deno.build.arch` maps 1:1). */
export function hostArch(): "x86_64" | "aarch64" {
  return Deno.build.arch;
}

/**
 * The smallest whole-GiB `--disk` that can boot `image`:
 * `ceil(virtualSizeBytes / 1024 ** 3)`. Lima grows a disk on boot but refuses
 * to shrink one, so this floor ratchets upward along a chain of derived
 * images.
 *
 * This is a BUILDER-side number ({@linkcode CreateOptions.diskGiB});
 * {@linkcode buildImage} applies it automatically for an
 * {@linkcode ImageBaseImage} base. Reach for it directly only to ask for a
 * bigger-but-legal disk: `diskGiB: Math.max(20, diskFloorGiB(image))`.
 * Consumers *booting* an image do not need it — see
 * {@linkcode configFromImage}.
 */
export function diskFloorGiB(image: BuiltImage): number {
  return Math.ceil(image.virtualSizeBytes / 1024 ** 3);
}

/**
 * Turn a built image into an `images:` entry: absolute `location`, the
 * image's `arch` and `digest`. Overrides win field-by-field.
 */
export function toImageSpec(
  image: BuiltImage,
  overrides: Partial<ImageSpec> = {},
): ImageSpec {
  return {
    location: image.path,
    ...(image.arch === undefined ? {} : { arch: image.arch }),
    digest: image.digest,
    ...definedEntries(overrides),
  };
}

/**
 * A {@linkcode LimaConfig} that boots from the image: `base` is spread
 * first, then `arch` (the image's wins) and `images` are replaced. The image
 * becomes the SOLE `images:` entry on purpose — Lima silently falls through
 * to the next entry on a digest mismatch, and a pinned local image should
 * fail loudly instead. Append fallbacks yourself via {@linkcode toImageSpec}.
 *
 * Constraints the caller owns:
 * - if you set `disk`, it must be >= {@linkcode BuiltImage.virtualSizeBytes}
 *   (Lima grows disks on boot but refuses to shrink them). Omitting it is the
 *   usual right answer: Lima's own default is far above any image this
 *   toolkit produces, so computing a `disk` from the image's virtual size
 *   only shrinks the VM. The floor matters on the *builder* side, where
 *   {@linkcode diskFloorGiB} applies it;
 * - booting a foreign-arch image needs `vmType: "qemu"` on the consuming
 *   host — not auto-set here, because the rendered config may be shared
 *   across hosts.
 */
export function configFromImage(
  image: BuiltImage,
  base: LimaConfig = {},
): LimaConfig {
  const arch = image.arch ?? base.arch;
  return {
    ...base,
    ...(arch === undefined ? {} : { arch }),
    images: [toImageSpec(image)],
  };
}

function definedEntries(overrides: Partial<ImageSpec>): Partial<ImageSpec> {
  return Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<ImageSpec>;
}
