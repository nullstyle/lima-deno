import { assert, assertEquals, assertRejects } from "@std/assert";
import { sha256File } from "../../src/image/digest.ts";

async function tempDir(): Promise<string> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  return await Deno.makeTempDir({ dir: "tests/.tmp" });
}

Deno.test("empty file hashes to the well-known empty sha256", async () => {
  const dir = await tempDir();
  try {
    const path = `${dir}/empty`;
    await Deno.writeFile(path, new Uint8Array());
    assertEquals(
      await sha256File(path),
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("known vector: 'hello world\\n'", async () => {
  const dir = await tempDir();
  try {
    const path = `${dir}/hello`;
    await Deno.writeTextFile(path, "hello world\n");
    assertEquals(
      await sha256File(path),
      "sha256:a948904f2f0f479b8f8197694b30184b0d2ed1c1cd2a1ec0fb85d299a192a447",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("multi-chunk file digests correctly with monotonic progress", async () => {
  const dir = await tempDir();
  try {
    const path = `${dir}/big`;
    // 256 KiB of a repeating byte — large enough for several read chunks.
    const bytes = new Uint8Array(256 * 1024).fill(0x61);
    await Deno.writeFile(path, bytes);
    const expected = await crypto.subtle.digest("SHA-256", bytes);
    const expectedHex = Array.from(
      new Uint8Array(expected),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

    const seen: [number, number][] = [];
    const digest = await sha256File(path, {
      onProgress: (bytesHashed, totalBytes) =>
        seen.push([bytesHashed, totalBytes]),
    });
    assertEquals(digest, `sha256:${expectedHex}`);
    assert(seen.length >= 1, "progress fired at least once");
    for (let index = 1; index < seen.length; index++) {
      assert(seen[index][0] > seen[index - 1][0], "progress is monotonic");
    }
    assertEquals(seen[seen.length - 1], [bytes.byteLength, bytes.byteLength]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a pre-aborted signal rejects with the signal's reason", async () => {
  const dir = await tempDir();
  try {
    const path = `${dir}/aborted`;
    await Deno.writeTextFile(path, "content");
    const controller = new AbortController();
    const reason = new Error("deadline hit");
    controller.abort(reason);
    const error = await assertRejects(() =>
      sha256File(path, { signal: controller.signal })
    );
    assertEquals(error, reason);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
