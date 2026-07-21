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
 * - the default seal leaves the image bootable with a fresh machine-id.
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
import { configFromImage, hostArch, toImageSpec } from "../src/image/spec.ts";
import type { ImageEvent } from "../src/image/types.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

function fail(label: string): never {
  console.error(`✗ ${label}`);
  Deno.exit(1);
}

function onEvent(event: ImageEvent): void {
  if (event.type === "phase") console.log(`  · phase: ${event.phase}`);
  if (event.type === "step") {
    console.log(`  · step ${event.index + 1}/${event.count}`);
  }
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
const dir = await Deno.makeTempDir({ prefix: "lima-image-smoke-" });
const outputPath = `${dir}/baked.${format}`;

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
  await Deno.remove(dir, { recursive: true }).catch(() => {});
}
