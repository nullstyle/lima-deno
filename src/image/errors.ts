/**
 * Typed errors raised by the image toolkit.
 *
 * Primitives throw precise underlying errors unwrapped
 * (`CommandError`, `QemuImgMissingError`, {@linkcode ImageCaptureError});
 * only `buildImage` wraps whatever escapes in {@linkcode ImageBuildError}
 * with phase context.
 *
 * @module
 */

import type { BuiltImage, ImageBuildPhase } from "./types.ts";

/**
 * A requested builder disk is smaller than the base image's virtual size.
 *
 * Lima grows a disk on boot but refuses to shrink one, so such a builder
 * could never boot. Raising the caller's number silently would be the kind of
 * editorializing this library avoids, so the conflict is surfaced early — in
 * pure arithmetic, before any VM exists — with both operands attached.
 */
export class ImageDiskFloorError extends Error {
  /** The base image imposing the floor. */
  readonly image: BuiltImage;
  /** What the caller asked for, in GiB. */
  readonly requestedGiB: number;
  /** What the image requires, in GiB. */
  readonly minimumGiB: number;

  /** Build the error; the message names both operands and Lima's rule. */
  constructor(image: BuiltImage, requestedGiB: number, minimumGiB: number) {
    super(
      `builder disk ${requestedGiB}GiB is below the ${minimumGiB}GiB floor of ` +
        `${image.path} (Lima grows disks on boot but refuses to shrink them)`,
    );
    this.name = "ImageDiskFloorError";
    this.image = image;
    this.requestedGiB = requestedGiB;
    this.minimumGiB = minimumGiB;
  }
}

/** `captureImage` could not capture from the given instance. */
export class ImageCaptureError extends Error {
  /** The instance capture targeted. */
  readonly instance: string;

  /** Build the error; `message` states what blocked the capture. */
  constructor(
    instance: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(`cannot capture image from ${instance}: ${message}`, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ImageCaptureError";
    this.instance = instance;
  }
}

/** `buildImage` failed; carries the phase, the builder VM name, and the cause. */
export class ImageBuildError extends Error {
  /** The phase that failed. */
  readonly phase: ImageBuildPhase;
  /** The builder VM's name. */
  readonly builder: string;
  /** The zero-based provision step, when the failure was in one. */
  readonly stepIndex?: number;
  /** Whether the builder VM was kept for debugging (`keepOnFailure`). */
  readonly kept: boolean;

  /** Build the error; the original failure rides along as `cause`. */
  constructor(
    phase: ImageBuildPhase,
    builder: string,
    options: { stepIndex?: number; kept?: boolean; cause?: unknown } = {},
  ) {
    super(
      `image build failed during ${phase} (builder VM ${builder}${
        options.stepIndex === undefined ? "" : ` at step ${options.stepIndex}`
      }${options.kept === true ? "; VM kept for debugging" : ""})`,
      { ...(options.cause === undefined ? {} : { cause: options.cause }) },
    );
    this.name = "ImageBuildError";
    this.phase = phase;
    this.builder = builder;
    if (options.stepIndex !== undefined) this.stepIndex = options.stepIndex;
    this.kept = options.kept === true;
  }
}

/** The `ImageStore`'s directory or manifest is unusable. */
export class ImageStoreError extends Error {
  /** The store path involved. */
  readonly path: string;

  /** Build the error for a store path. */
  constructor(
    message: string,
    path: string,
    options: { cause?: unknown } = {},
  ) {
    super(`${message}: ${path}`, {
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "ImageStoreError";
    this.path = path;
  }
}
