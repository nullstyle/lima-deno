/**
 * Real-Lima image smoke: builds a custom image from a real builder VM, then
 * boots a derived VM from it and proves the provisioning was baked in. Run
 * manually before tagging a release:
 *
 *     deno task smoke:image
 *
 * Loud-skips (exit 0) when limactl is not installed. NOT run in CI. With
 * qemu-img installed the capture is qcow2 (compressed); without it the raw
 * `cp`-clone path is exercised instead.
 *
 * Verifies the externally-unproven contracts specifically:
 * - local-path `images[].location` with a `sha256:` digest pin is accepted;
 * - a tampered digest fails the create (no silent fallback);
 * - compressed qcow2 output boots under vz (Lima's native zlib reader);
 * - a derived VM with a bigger `disk:` grows on boot (growpart);
 * - the default seal leaves the image bootable with a fresh machine-id;
 * - a built image can serve as the BASE of another build, stacking two
 *   generations of provisioning (the premise of examples/devbox_image.ts);
 * - the builder disk floor is enforced in preflight, before any VM boots.
 *
 * Cross-arch (x86_64 on Apple Silicon via qemu TCG) is exercised only with
 * IMAGE_SMOKE_CROSS_ARCH=1 — it needs `brew install qemu` and tens of
 * minutes.
 *
 * @module
 */

import { Limactl } from "../src/limactl.ts";
import { QemuImg } from "@nullstyle/qemu-img";
import { buildImage } from "../src/image/build.ts";
import {
  configFromImage,
  diskFloorGiB,
  hostArch,
  toImageSpec,
} from "../src/image/spec.ts";
import { formatImageEvent } from "../src/image/format.ts";
import { ImageBuildError, ImageDiskFloorError } from "../src/image/errors.ts";
import { withInstance } from "../src/ephemeral.ts";
import type { ImageEvent } from "../src/image/types.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

function fail(label: string): never {
  console.error(`✗ ${label}`);
  Deno.exit(1);
}

function onEvent(event: ImageEvent): void {
  const line = formatImageEvent(event);
  if (line !== undefined) console.log(`  · ${line}`);
}

const lima = new Limactl();
if (!(await lima.available())) {
  skip("Lima not installed (brew install lima) — image smoke skipped");
  Deno.exit(0);
}
await lima.requireVersion();

const qemu = new QemuImg();
const haveQemuImg = await qemu.available();
const format = haveQemuImg ? "qcow2" : "raw";
pass(
  haveQemuImg
    ? `qemu-img present — capturing compressed qcow2`
    : "qemu-img absent — exercising the raw cp-clone path (brew install qemu for qcow2)",
);

const stamp = Date.now().toString(36);
const builderName = `img-smoke-b-${stamp}`;
const derivedName = `img-smoke-d-${stamp}`;
const negativeName = `img-smoke-x-${stamp}`;
const gen2Name = `img-smoke-g2-${stamp}`;
const gen2VmName = `img-smoke-g2vm-${stamp}`;
const dir = await Deno.makeTempDir({ prefix: "lima-image-smoke-" });
const outputPath = `${dir}/baked.${format}`;
const gen2Path = `${dir}/baked-gen2.${format}`;

let builderMachineId = "";

try {
  step(`build ${builderName}: template ubuntu-24.04, marker + seal, 8GiB disk`);
  const image = await buildImage(lima, {
    base: { template: "ubuntu-24.04" },
    outputPath,
    format,
    name: builderName,
    create: { diskGiB: 8 },
    steps: [
      {
        run: "touch /opt/img-smoke-marker",
        sudo: true,
        comment: "drop the provisioning marker",
      },
      {
        fn: async (vm) => {
          const result = await vm.exec("cat /etc/machine-id", { check: true });
          builderMachineId = result.stdout.trim();
        },
        comment: "record the builder machine-id",
      },
    ],
  }, { onEvent, timeoutMs: 900_000 });

  if (!/^sha256:[0-9a-f]{64}$/.test(image.digest)) {
    fail(`digest shape: ${image.digest}`);
  }
  if (image.virtualSizeBytes !== 8 * 1024 ** 3) {
    fail(`virtual size: expected 8GiB, got ${image.virtualSizeBytes}`);
  }
  if (format === "qcow2" && image.sizeBytes > 3 * 1024 ** 3) {
    fail(`compressed qcow2 unexpectedly large: ${image.sizeBytes} bytes`);
  }
  pass(
    `built ${image.path} (${(image.sizeBytes / 1024 ** 2).toFixed(0)} MiB, ` +
      `virtual ${(image.virtualSizeBytes / 1024 ** 3).toFixed(0)} GiB, ` +
      `${image.digest.slice(0, 19)}…)`,
  );

  step("negative check: a tampered digest must fail the create");
  let tamperRejected = false;
  try {
    await lima.create(negativeName, {
      config: {
        arch: image.arch ?? hostArch(),
        images: [toImageSpec(image, { digest: `sha256:${"0".repeat(64)}` })],
        disk: "10GiB",
        mounts: [],
      },
    }, { timeoutMs: 300_000 });
  } catch {
    tamperRejected = true;
  } finally {
    await lima.instance(negativeName).delete().catch(() => {});
  }
  if (!tamperRejected) {
    fail("create with a tampered digest unexpectedly succeeded");
  }
  pass("digest pin is verified for local paths (tamper rejected)");

  step(`boot ${derivedName} from the baked image with disk grown to 12GiB`);
  const derived = await lima.create(derivedName, {
    config: configFromImage(image, { disk: "12GiB", mounts: [] }),
  }, { timeoutMs: 900_000 });
  await derived.waitReady({ timeoutMs: 300_000 });

  await derived.exec("test -f /opt/img-smoke-marker", { check: true });
  pass("marker present — provisioning was baked into the image");

  const derivedMachineId =
    (await derived.exec("cat /etc/machine-id", { check: true })).stdout.trim();
  if (derivedMachineId.length === 0 || derivedMachineId === builderMachineId) {
    fail(
      `machine-id not regenerated (builder ${builderMachineId}, derived ${derivedMachineId})`,
    );
  }
  pass("machine-id regenerated on the derived VM (seal worked)");

  const rootKb = Number(
    (await derived.exec("df -k / | awk 'NR==2{print $2}'", { check: true }))
      .stdout.trim(),
  );
  if (!(rootKb > 10 * 1024 * 1024)) {
    fail(`root fs did not grow past 10GiB (df -k: ${rootKb})`);
  }
  pass(`root fs grew with the 12GiB derived disk (df -k: ${rootKb})`);

  await derived.delete();
  pass("derived VM deleted");

  // Derivation: build a SECOND generation using the first image as the
  // builder's base. Nothing else proves a Lima image can serve as its own
  // base, and it is the whole premise of examples/devbox_image.ts.
  step(`derive ${gen2Name} from the baked image (a second generation)`);
  const gen2 = await buildImage(lima, {
    base: { image },
    outputPath: gen2Path,
    format,
    name: gen2Name,
    steps: [
      {
        run: "touch /opt/img-smoke-marker-2",
        sudo: true,
        comment: "drop the second-generation marker",
      },
    ],
  }, { onEvent, timeoutMs: 900_000 });

  // The floor ratchets: a derived image can never be smaller than its base,
  // and this is the only place that is observable.
  if (gen2.virtualSizeBytes < image.virtualSizeBytes) {
    fail(
      `derived virtual size shrank: ${gen2.virtualSizeBytes} < ` +
        `${image.virtualSizeBytes}`,
    );
  }
  pass(
    `derived ${(gen2.sizeBytes / 1024 ** 2).toFixed(0)} MiB, virtual ` +
      `${(gen2.virtualSizeBytes / 1024 ** 3).toFixed(0)} GiB`,
  );

  step(`boot from the derived image — both generations' work must survive`);
  await withInstance(
    lima,
    gen2VmName,
    { config: configFromImage(gen2, { mounts: [] }) },
    async (vm) => {
      // The first marker proves gen 1's provisioning survived derivation;
      // the second proves gen 2's steps ran on top of it.
      await vm.exec("test -f /opt/img-smoke-marker", { check: true });
      await vm.exec("test -f /opt/img-smoke-marker-2", { check: true });
    },
    { timeoutMs: 900_000 },
  );
  pass("both markers present — derivation stacks provisioning");

  // Cheap negative: the disk floor is enforced in preflight, before any VM.
  step("a sub-floor builder disk is refused before anything boots");
  try {
    await buildImage(lima, {
      base: { image: gen2 },
      outputPath: `${dir}/never.${format}`,
      create: { diskGiB: diskFloorGiB(gen2) - 1 },
      name: `img-smoke-floor-${stamp}`,
    }, { onEvent });
    fail("sub-floor disk was accepted");
  } catch (error) {
    const cause = error instanceof ImageBuildError ? error.cause : undefined;
    if (!(cause instanceof ImageDiskFloorError)) {
      fail(`expected ImageDiskFloorError, got ${error}`);
    }
    pass("sub-floor disk rejected in preflight");
  }

  if (Deno.env.get("IMAGE_SMOKE_CROSS_ARCH") === "1") {
    const foreign = hostArch() === "aarch64" ? "x86_64" : "aarch64";
    step(
      `cross-arch: build a ${foreign} image under qemu TCG (this takes a while…)`,
    );
    const crossOut = `${dir}/baked-${foreign}.qcow2`;
    const crossImage = await buildImage(lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: crossOut,
      arch: foreign,
      name: `img-smoke-c-${stamp}`,
      create: { vmType: "qemu", diskGiB: 8 },
      steps: [{ run: "touch /opt/img-smoke-marker", sudo: true }],
    }, { onEvent, timeoutMs: 1_800_000 });
    const crossVm = await lima.create(`img-smoke-cd-${stamp}`, {
      config: configFromImage(crossImage, {
        vmType: "qemu",
        disk: "10GiB",
        mounts: [],
      }),
    }, { timeoutMs: 1_800_000 });
    try {
      await crossVm.waitReady({ timeoutMs: 1_800_000 });
      const uname = (await crossVm.exec("uname -m", { check: true })).stdout
        .trim();
      if (uname !== foreign) fail(`cross-arch uname -m: ${uname}`);
      await crossVm.exec("test -f /opt/img-smoke-marker", { check: true });
      pass(`cross-arch ${foreign} image builds and boots`);
    } finally {
      await crossVm.delete().catch(() => {});
    }
  } else {
    skip("cross-arch section skipped (set IMAGE_SMOKE_CROSS_ARCH=1 to run)");
  }

  console.log("\nimage smoke: all green");
} finally {
  await lima.instance(builderName).delete().catch(() => {});
  await lima.instance(derivedName).delete().catch(() => {});
  await lima.instance(gen2VmName).delete().catch(() => {});
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
