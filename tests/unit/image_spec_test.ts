import { assertEquals } from "@std/assert";
import {
  configFromImage,
  hostArch,
  toImageSpec,
} from "../../src/image/spec.ts";
import type { BuiltImage } from "../../src/image/types.ts";

const image: BuiltImage = {
  path: "/images/baked.qcow2",
  format: "qcow2",
  digest: "sha256:abc123",
  arch: "aarch64",
  sizeBytes: 1000,
  virtualSizeBytes: 10 * 1024 ** 3,
};

Deno.test("hostArch mirrors Deno.build.arch", () => {
  assertEquals(hostArch(), Deno.build.arch);
});

Deno.test("toImageSpec carries location/arch/digest; overrides win", () => {
  assertEquals(toImageSpec(image), {
    location: "/images/baked.qcow2",
    arch: "aarch64",
    digest: "sha256:abc123",
  });
  assertEquals(
    toImageSpec(image, {
      location: "https://example.com/baked.qcow2",
      comment: "published copy",
    }),
    {
      location: "https://example.com/baked.qcow2",
      arch: "aarch64",
      digest: "sha256:abc123",
      comment: "published copy",
    },
  );
});

Deno.test("toImageSpec omits arch when the image has none", () => {
  const { arch: _arch, ...archless } = image;
  assertEquals(toImageSpec(archless), {
    location: "/images/baked.qcow2",
    digest: "sha256:abc123",
  });
});

Deno.test("configFromImage replaces images with the sole pinned entry", () => {
  const config = configFromImage(image, {
    disk: "20GiB",
    mounts: [],
    images: [{ location: "https://example.com/old.qcow2" }],
    arch: "x86_64",
  });
  assertEquals(config, {
    disk: "20GiB",
    mounts: [],
    arch: "aarch64", // the image's arch wins
    images: [{
      location: "/images/baked.qcow2",
      arch: "aarch64",
      digest: "sha256:abc123",
    }],
  });
});

Deno.test("configFromImage keeps the base arch when the image has none", () => {
  const { arch: _arch, ...archless } = image;
  const config = configFromImage(archless, { arch: "x86_64" });
  assertEquals(config.arch, "x86_64");
  const bare = configFromImage(archless);
  assertEquals(bare.arch, undefined);
});
