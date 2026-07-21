/**
 * Streaming file digests for multi-gigabyte images.
 *
 * Uses `@std/crypto`'s iterable-accepting `crypto.subtle.digest`, which
 * hashes chunk by chunk — the file is never buffered whole.
 *
 * @module
 */

import { crypto } from "@std/crypto";

/** Options for {@linkcode sha256File}. */
export interface Sha256FileOptions {
  /** Abort the hash mid-file. */
  readonly signal?: AbortSignal;
  /** Called after each chunk with cumulative bytes hashed and the file's total size. */
  readonly onProgress?: (bytesHashed: number, totalBytes: number) => void;
}

/**
 * Stream-hash a file (any size) and return a Lima-style digest pin,
 * `"sha256:<hex>"` — the exact form `images[].digest` expects.
 */
export async function sha256File(
  path: string,
  options: Sha256FileOptions = {},
): Promise<string> {
  const totalBytes = (await Deno.stat(path)).size;
  const file = await Deno.open(path, { read: true });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    chunks(file, totalBytes, options),
  );
  return `sha256:${hex(new Uint8Array(digest))}`;
}

async function* chunks(
  file: Deno.FsFile,
  totalBytes: number,
  options: Sha256FileOptions,
): AsyncIterable<Uint8Array<ArrayBuffer>> {
  let bytesHashed = 0;
  // Throwing out of this loop cancels file.readable, which closes the fd —
  // no manual close on either path.
  for await (const chunk of file.readable) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error("sha256File aborted");
    }
    bytesHashed += chunk.byteLength;
    yield chunk;
    options.onProgress?.(bytesHashed, totalBytes);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
