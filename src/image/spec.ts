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
 * - `disk` must be >= {@linkcode BuiltImage.virtualSizeBytes} (Lima grows
 *   disks on boot but refuses to shrink them);
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
