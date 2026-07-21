/**
 * Shared types for image capture and building.
 *
 * @module
 */

/** Disk image formats the image toolkit produces. */
export type ImageFormat = "qcow2" | "raw";

/**
 * A standalone disk image on the host, with provenance. Plain, serializable
 * data — see {@linkcode import("./spec.ts").toImageSpec} and
 * {@linkcode import("./spec.ts").configFromImage} for turning one into Lima
 * config.
 */
export interface BuiltImage {
  /** Absolute host path to the image file. */
  readonly path: string;
  /** The image's format. */
  readonly format: ImageFormat;
  /** Content digest of the file as stored, `"sha256:<hex>"`. */
  readonly digest: string;
  /** Lima guest arch (e.g. `"aarch64"`), when the source instance reported one. */
  readonly arch?: string;
  /** On-disk size of the image file in bytes. */
  readonly sizeBytes: number;
  /**
   * Guest-visible size in bytes. A VM booting this image needs `disk` >= this
   * (Lima grows disks but refuses to shrink them).
   */
  readonly virtualSizeBytes: number;
}

/** Phases of an image build/capture, in execution order. */
export type ImageBuildPhase =
  | "preflight"
  | "create"
  | "wait-ready"
  | "provision"
  | "seal"
  | "stop"
  | "inspect"
  | "convert"
  | "digest"
  | "cleanup";

/**
 * One progress event emitted by `captureImage`/`buildImage` through their
 * `onEvent` callback (the library never logs).
 */
export type ImageEvent =
  | {
    /** A phase began. */
    readonly type: "phase";
    /** The phase. */
    readonly phase: ImageBuildPhase;
    /** The instance involved. */
    readonly instance: string;
  }
  | {
    /** A provision step began. */
    readonly type: "step";
    /** Zero-based step index. */
    readonly index: number;
    /** Total step count. */
    readonly count: number;
    /** The step's comment, when present. */
    readonly comment?: string;
  }
  | {
    /** Digest progress over the output file. */
    readonly type: "digest-progress";
    /** Cumulative bytes hashed. */
    readonly bytesHashed: number;
    /** The file's total size. */
    readonly totalBytes: number;
  };
