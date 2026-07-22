import { assertEquals, assertThrows } from "@std/assert";
import { type ImageBase, resolveImageBase } from "../../src/image/build.ts";
import { configFromImage, diskFloorGiB } from "../../src/image/spec.ts";
import { ImageDiskFloorError } from "../../src/image/errors.ts";
import { formatImageEvent } from "../../src/image/format.ts";
import type { BuiltImage } from "../../src/image/types.ts";

const GIB = 1024 ** 3;

function image(overrides: Partial<BuiltImage> = {}): BuiltImage {
  return {
    path: "/images/base.qcow2",
    format: "qcow2",
    digest: "sha256:" + "ab".repeat(32),
    arch: "aarch64",
    sizeBytes: 512 * 1024 * 1024,
    virtualSizeBytes: 12 * GIB,
    ...overrides,
  };
}

Deno.test("diskFloorGiB rounds up to whole GiB", () => {
  assertEquals(diskFloorGiB(image({ virtualSizeBytes: 12 * GIB })), 12);
  assertEquals(diskFloorGiB(image({ virtualSizeBytes: 10 * GIB + 1 })), 11);
  assertEquals(diskFloorGiB(image({ virtualSizeBytes: 0 })), 0);
});

Deno.test("resolveImageBase passes a CreateSource through untouched", () => {
  const base: ImageBase = { template: "ubuntu-24.04" };
  const resolved = resolveImageBase(base);
  assertEquals(resolved.source, base);
  assertEquals(resolved.create, {
    plain: true,
    cpus: 2,
    memoryGiB: 2,
    diskGiB: 10,
  });
  assertEquals(resolved.arch, undefined);
});

Deno.test("a plain source keeps a caller's small disk (no image, no floor)", () => {
  // Regression guard: the floor must not leak onto non-image bases, which
  // tools/image_smoke.ts relies on when it builds an 8GiB image.
  const resolved = resolveImageBase({ template: "ubuntu-24.04" }, {
    diskGiB: 8,
  });
  assertEquals(resolved.create.diskGiB, 8);
});

Deno.test("an image base pins the config and raises the disk to its floor", () => {
  const base = image();
  const resolved = resolveImageBase({ image: base });
  assertEquals(resolved.source, { config: configFromImage(base) });
  assertEquals(resolved.create.diskGiB, 12);
  assertEquals(resolved.arch, "aarch64");
});

Deno.test("a base smaller than the builder default keeps the default", () => {
  const resolved = resolveImageBase({
    image: image({ virtualSizeBytes: 4 * GIB }),
  });
  assertEquals(resolved.create.diskGiB, 10);
});

Deno.test("extra base config merges under the image's pinned entry", () => {
  const base = image();
  const resolved = resolveImageBase({
    image: base,
    config: { cpus: 8, vmType: "qemu" },
  });
  const config = "config" in resolved.source ? resolved.source.config : {};
  assertEquals(config.cpus, 8);
  assertEquals(config.vmType, "qemu");
  // The image still wins where they overlap.
  assertEquals(config.images, [{
    location: base.path,
    arch: "aarch64",
    digest: base.digest,
  }]);
});

Deno.test("a bigger explicit disk wins over the floor", () => {
  const resolved = resolveImageBase({ image: image() }, { diskGiB: 20 });
  assertEquals(resolved.create.diskGiB, 20);
});

Deno.test("a sub-floor explicit disk throws with both operands", () => {
  const base = image();
  const error = assertThrows(
    () => resolveImageBase({ image: base }, { diskGiB: 8 }),
    ImageDiskFloorError,
  );
  assertEquals(error.requestedGiB, 8);
  assertEquals(error.minimumGiB, 12);
  assertEquals(error.image, base);
});

Deno.test("a derived build infers arch for preflight but emits no --arch", () => {
  const resolved = resolveImageBase({ image: image({ arch: "x86_64" }) });
  assertEquals(resolved.arch, "x86_64");
  // The derived config already pins arch: in the YAML piped on stdin, so the
  // flag would be redundant argv churn.
  assertEquals(resolved.create.arch, undefined);
});

Deno.test("an explicit arch overrides the base image's", () => {
  const resolved = resolveImageBase(
    { image: image({ arch: "aarch64" }) },
    {},
    "x86_64",
  );
  assertEquals(resolved.arch, "x86_64");
  assertEquals(resolved.create.arch, "x86_64");
});

Deno.test("formatImageEvent renders phases, steps, and declines progress", () => {
  assertEquals(
    formatImageEvent({ type: "phase", phase: "create", instance: "b1" }),
    "create",
  );
  assertEquals(
    formatImageEvent({
      type: "step",
      index: 1,
      count: 5,
      comment: "base packages",
    }),
    "2/5 base packages",
  );
  assertEquals(
    formatImageEvent({ type: "step", index: 1, count: 5 }),
    "2/5 step 2",
  );
  // Per-chunk: presentation and throttling stay the caller's.
  assertEquals(
    formatImageEvent({
      type: "digest-progress",
      bytesHashed: 1,
      totalBytes: 2,
    }),
    undefined,
  );
});
