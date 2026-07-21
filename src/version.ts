/**
 * `limactl` version parsing and the compatibility window this library targets.
 *
 * @module
 */

import { LimaOutputError } from "./errors.ts";

/** A parsed `limactl --version`. */
export interface LimactlVersion {
  /** The raw version string as printed (e.g. `"1.0.6"`, `"1.1.0-12-gabc1234"`). */
  readonly raw: string;
  /** Major version component. */
  readonly major: number;
  /** Minor version component. */
  readonly minor: number;
  /** Patch version component. */
  readonly patch: number;
  /** Prerelease / git-describe suffix, when present (e.g. `"12-gabc1234"`). */
  readonly prerelease?: string;
}

/**
 * The limactl window this library targets.
 *
 * `minimum` is the floor {@linkcode import("./limactl.ts").Limactl.requireVersion}
 * checks by default: Lima 1.0.0 is the first stable release with vz
 * `nestedVirtualization`, the modern `template:` locator, and the current
 * `list --json` shape. `tested` is the version the release smoke last ran
 * against.
 */
export const LIMA_COMPAT: {
  readonly minimum: string;
  readonly tested: string;
} = Object.freeze({
  minimum: "1.0.0",
  tested: "1.0.0",
});

const VERSION_PATTERN =
  /version\s+v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.+-]+))?/;
const BARE_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.+-]+))?$/;

/**
 * Parse `limactl --version` output. Accepts the release form
 * (`limactl version 1.0.6`), git-describe dev builds
 * (`limactl version 1.1.0-12-gabc1234`), and a bare version string.
 * Throws {@linkcode LimaOutputError} when the output is unrecognizable.
 */
export function parseLimactlVersion(output: string): LimactlVersion {
  const trimmed = output.trim();
  const match = VERSION_PATTERN.exec(trimmed) ?? BARE_PATTERN.exec(trimmed);
  if (match === null) {
    throw new LimaOutputError(
      `unrecognized limactl version output`,
      output,
    );
  }
  const [, major, minor, patch, prerelease] = match;
  const raw = `${major}.${minor}.${patch}${
    prerelease === undefined ? "" : `-${prerelease}`
  }`;
  return {
    raw,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    ...(prerelease === undefined ? {} : { prerelease }),
  };
}

/**
 * Compare two parsed versions numerically. A prerelease sorts BEFORE its
 * release (`1.1.0-rc1 < 1.1.0`), matching semver intuition; two prereleases
 * on the same triple compare as equal (git-describe suffixes have no total
 * order worth pretending to).
 */
export function compareLimactlVersions(
  a: LimactlVersion,
  b: LimactlVersion,
): number {
  for (
    const key of ["major", "minor", "patch"] as const
  ) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  const aPre = a.prerelease !== undefined;
  const bPre = b.prerelease !== undefined;
  if (aPre === bPre) return 0;
  return aPre ? -1 : 1;
}
