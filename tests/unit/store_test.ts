import { assert, assertEquals, assertRejects } from "@std/assert";
import { ImageStore } from "../../src/image/store.ts";
import { ImageStoreError } from "../../src/image/errors.ts";
import type { BuiltImage } from "../../src/image/types.ts";

const FIXED_NOW = () => new Date("2026-07-21T12:00:00.000Z");

async function rig(): Promise<
  { root: string; store: ImageStore; image: BuiltImage }
> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  const root = await Deno.makeTempDir({ dir: "tests/.tmp" });
  const imagePath = `${root}/built.qcow2`;
  await Deno.writeTextFile(imagePath, "QCOW-BYTES");
  const image: BuiltImage = {
    path: await Deno.realPath(imagePath),
    format: "qcow2",
    digest: "sha256:0123456789abcdef0123456789abcdef",
    arch: "aarch64",
    sizeBytes: 10,
    virtualSizeBytes: 1024,
  };
  return {
    root,
    store: new ImageStore({ dir: `${root}/store`, now: FIXED_NOW }),
    image,
  };
}

Deno.test("put copies into a digest-named file and writes a byte-pinned manifest", async () => {
  const { root, store, image } = await rig();
  try {
    const stored = await store.put("dev-base", image);
    assertEquals(stored.name, "dev-base");
    assertEquals(stored.createdAt, "2026-07-21T12:00:00.000Z");
    assert(stored.path.endsWith("/store/dev-base-0123456789ab.qcow2"));
    assertEquals(await Deno.readTextFile(stored.path), "QCOW-BYTES");
    // The source file is untouched by a copy-put.
    assertEquals(await Deno.readTextFile(image.path), "QCOW-BYTES");

    const manifest = await Deno.readTextFile(`${root}/store/manifest.json`);
    assertEquals(
      manifest,
      JSON.stringify(
        {
          version: 1,
          images: {
            "dev-base": {
              file: "dev-base-0123456789ab.qcow2",
              format: "qcow2",
              digest: "sha256:0123456789abcdef0123456789abcdef",
              arch: "aarch64",
              sizeBytes: 10,
              virtualSizeBytes: 1024,
              createdAt: "2026-07-21T12:00:00.000Z",
            },
          },
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("get/list/resolve round-trip; list sorts by name", async () => {
  const { root, store, image } = await rig();
  try {
    await store.put("bravo", image);
    await store.put("alpha", image);

    const listed = await store.list();
    assertEquals(listed.map((entry) => entry.name), ["alpha", "bravo"]);

    const got = await store.get("alpha");
    assertEquals(got?.digest, image.digest);
    assertEquals(got?.virtualSizeBytes, 1024);
    assertEquals(await store.get("ghost"), undefined);

    const spec = await store.resolve("alpha");
    assert(spec !== undefined);
    assert(spec.location.startsWith("/"), "resolved location is absolute");
    assertEquals(spec.arch, "aarch64");
    assertEquals(spec.digest, image.digest);
    assertEquals(await store.resolve("ghost"), undefined);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("move: true renames the source into the store", async () => {
  const { root, store, image } = await rig();
  try {
    await store.put("moved", image, { move: true });
    await assertRejects(() => Deno.stat(image.path), "source is gone");
    const got = await store.get("moved");
    assertEquals(await Deno.readTextFile(got!.path), "QCOW-BYTES");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("put overwrites: a new digest replaces the old file", async () => {
  const { root, store, image } = await rig();
  try {
    const first = await store.put("app", image);
    const nextPath = `${root}/built2.qcow2`;
    await Deno.writeTextFile(nextPath, "V2");
    const second = await store.put("app", {
      ...image,
      path: await Deno.realPath(nextPath),
      digest: "sha256:fedcba9876543210fedcba9876543210",
      sizeBytes: 2,
    });
    assert(second.path.endsWith("app-fedcba987654.qcow2"));
    await assertRejects(() => Deno.stat(first.path), "old file removed");
    assertEquals((await store.list()).length, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("remove deletes file + entry; false for absent names", async () => {
  const { root, store, image } = await rig();
  try {
    const stored = await store.put("gone", image);
    assertEquals(await store.remove("gone"), true);
    await assertRejects(() => Deno.stat(stored.path));
    assertEquals(await store.get("gone"), undefined);
    assertEquals(await store.remove("gone"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("an empty or missing store lists as empty; init is idempotent", async () => {
  const { root, store } = await rig();
  try {
    assertEquals(await store.list(), []);
    await store.init();
    await store.init();
    assertEquals(
      await Deno.readTextFile(`${root}/store/manifest.json`),
      '{\n  "version": 1,\n  "images": {}\n}\n',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a corrupt manifest throws ImageStoreError", async () => {
  const { root, store, image } = await rig();
  try {
    await store.init();
    await Deno.writeTextFile(`${root}/store/manifest.json`, "{nope");
    await assertRejects(() => store.list(), ImageStoreError, "not valid JSON");
    await Deno.writeTextFile(`${root}/store/manifest.json`, '{"version": 9}');
    await assertRejects(
      () => store.put("x", image),
      ImageStoreError,
      "unsupported shape",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("names are validated before touching the filesystem", async () => {
  const { root, store, image } = await rig();
  try {
    await assertRejects(
      () => store.put("../escape", image),
      ImageStoreError,
      "names must match",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
