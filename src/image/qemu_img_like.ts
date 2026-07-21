/**
 * The structural slice of a qemu-img client the image toolkit drives.
 *
 * `@nullstyle/qemu-img`'s `QemuImg` satisfies this interface as-is (that is
 * what the defaults construct); the indirection keeps this package's public
 * API self-contained and lets tests substitute anything shape-compatible.
 *
 * @module
 */

/** Cancellation options accepted by {@linkcode QemuImgLike} calls. */
export interface QemuImgCallOptions {
  /** Abort the call. */
  readonly signal?: AbortSignal;
  /** Deadline for the call in milliseconds. */
  readonly timeoutMs?: number;
}

/** The convert options the capture path uses. */
export interface QemuImgLikeConvertOptions extends QemuImgCallOptions {
  /** Output format (`-O`). */
  readonly format: string;
  /** Compress output clusters (`-c`). */
  readonly compress?: boolean;
  /** Source format (`-f`, skips probing). */
  readonly sourceFormat?: string;
}

/** The image info the capture path reads back. */
export interface QemuImgLikeInfo {
  /** Guest-visible size in bytes, when reported. */
  readonly virtualSizeBytes?: number;
}

/** The qemu-img client surface {@linkcode import("./capture.ts").captureImage} needs. */
export interface QemuImgLike {
  /** Throw when qemu-img is missing on this host. */
  ensureAvailable(options?: QemuImgCallOptions): Promise<void>;
  /** Convert `source` into `dest`. */
  convert(
    source: string,
    dest: string,
    options: QemuImgLikeConvertOptions,
  ): Promise<void>;
  /** Typed `qemu-img info` for `path`. */
  info(path: string, options?: QemuImgCallOptions): Promise<QemuImgLikeInfo>;
}
