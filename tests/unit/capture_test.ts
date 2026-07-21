import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { QemuImg, QemuImgMissingError } from "@nullstyle/qemu-img";
import { FakeQemuImg } from "@nullstyle/qemu-img/testing";
import { Limactl } from "../../src/limactl.ts";
import type { CommandResult, CommandRunner } from "../../src/runner.ts";
import { FakeLimactl, ok } from "../../testing/mod.ts";
import { captureImage } from "../../src/image/capture.ts";
import { ImageCaptureError } from "../../src/image/errors.ts";
import type { ImageEvent } from "../../src/image/types.ts";

const QCOW2_MAGIC = new Uint8Array([0x51, 0x46, 0x49, 0xfb]);
const ASIF_MAGIC = new Uint8Array([0x73, 0x68, 0x64, 0x77]);

// The known sha256 of the 3 bytes "IMG" written by the convert hook below.
const IMG_SHA256 =
  "sha256:d083ab0535d61b80b9565e9d0e1b356cd3f26f616fde9d08ad4fc4d2f784c2ba";

interface Rig {
  dir: string;
  diskPath: string;
  outputPath: string;
  fakeLima: FakeLimactl;
  fakeQemu: FakeQemuImg;
  lima: Limactl;
  qemuImg: QemuImg;
  events: ImageEvent[];
}

async function rig(diskBytes: Uint8Array): Promise<Rig> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "tests/.tmp" });
  const diskPath = `${dir}/disk`;
  await Deno.writeFile(diskPath, diskBytes);
  const fakeLima = new FakeLimactl();
  fakeLima.setInstance("vm1", { status: "Running", dir, arch: "aarch64" });
  const fakeQemu = new FakeQemuImg();
  fakeQemu.onConvert = (convert) => {
    Deno.writeTextFileSync(convert.dest, "IMG");
  };
  return {
    dir,
    diskPath,
    outputPath: `${dir}/out.img`,
    fakeLima,
    fakeQemu,
    lima: new Limactl({ runner: fakeLima }),
    qemuImg: new QemuImg({ runner: fakeQemu }),
    events: [],
  };
}

function cleanup(r: Rig): Promise<void> {
  return Deno.remove(r.dir, { recursive: true });
}

Deno.test("qcow2 capture: stop, sniff, convert -c, digest, atomic rename", async () => {
  const r = await rig(new Uint8Array(64)); // zeros → sniffs as raw (vz disk)
  try {
    r.fakeQemu.setImage(r.diskPath, {
      format: "raw",
      virtualSizeBytes: 8 * 1024 ** 3,
    });
    const image = await captureImage(r.lima.instance("vm1"), {
      outputPath: r.outputPath,
      qemuImg: r.qemuImg,
      onEvent: (event) => r.events.push(event),
    });

    assertEquals(r.fakeLima.commandLines(), [
      "limactl list --json",
      "limactl stop vm1",
    ]);
    assertEquals(r.fakeQemu.commandLines(), [
      "qemu-img --version",
      `qemu-img convert -f raw -c -O qcow2 ${r.diskPath} ${r.outputPath}.tmp`,
      `qemu-img info --output=json ${r.outputPath}.tmp`,
    ]);

    assertEquals(image.format, "qcow2");
    assertEquals(image.digest, IMG_SHA256);
    assertEquals(image.arch, "aarch64");
    assertEquals(image.sizeBytes, 3);
    assertEquals(image.virtualSizeBytes, 8 * 1024 ** 3);
    assert(image.path.startsWith("/"), "path is absolute");
    assertEquals(await Deno.readTextFile(image.path), "IMG");
    // The .tmp is gone — the rename was the commit.
    await assertRejects(() => Deno.stat(`${r.outputPath}.tmp`));

    const phases = r.events
      .filter((event) => event.type === "phase")
      .map((event) => event.phase);
    assertEquals(phases, ["stop", "inspect", "convert", "digest"]);
    assert(
      r.events.some((event) => event.type === "digest-progress"),
      "digest progress fired",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("a qcow2 source disk is sniffed and passed as -f qcow2", async () => {
  const r = await rig(QCOW2_MAGIC);
  try {
    r.fakeLima.setInstance("vm1", { status: "Stopped" });
    r.fakeQemu.setImage(r.diskPath, { format: "qcow2" });
    await captureImage(r.lima.instance("vm1"), {
      outputPath: r.outputPath,
      compress: false,
      qemuImg: r.qemuImg,
    });
    assertEquals(
      r.fakeQemu.commandLines()[1],
      [
        "qemu-img convert -f qcow2 -O qcow2",
        `${r.diskPath} ${r.outputPath}.tmp`,
      ].join(" "),
    );
    // Already Stopped: no `limactl stop` was issued.
    assertEquals(r.fakeLima.commandLines(), ["limactl list --json"]);
  } finally {
    await cleanup(r);
  }
});

Deno.test("raw capture from a raw source clones with cp — no qemu-img needed", async () => {
  const raw = new Uint8Array(32).fill(0x7a);
  const r = await rig(raw);
  try {
    r.fakeQemu.available = false; // qemu-img absent: raw capture must still work
    const cpCalls: string[][] = [];
    const cpRunner: CommandRunner = {
      run(bin, args): Promise<CommandResult> {
        cpCalls.push([bin, ...args]);
        Deno.copyFileSync(args[args.length - 2], args[args.length - 1]);
        return Promise.resolve(ok());
      },
    };
    const image = await captureImage(r.lima.instance("vm1"), {
      outputPath: r.outputPath,
      format: "raw",
      qemuImg: r.qemuImg,
      runner: cpRunner,
    });
    assertEquals(cpCalls, [["cp", "-c", r.diskPath, `${r.outputPath}.tmp`]]);
    assertEquals(r.fakeQemu.calls.length, 0);
    assertEquals(image.format, "raw");
    assertEquals(image.sizeBytes, raw.byteLength);
    assertEquals(image.virtualSizeBytes, raw.byteLength);
    assertEquals(await Deno.readFile(image.path), raw);
  } finally {
    await cleanup(r);
  }
});

Deno.test("raw capture from a qcow2 source requires qemu-img", async () => {
  const r = await rig(QCOW2_MAGIC);
  try {
    r.fakeQemu.setImage(r.diskPath, { format: "qcow2" });
    await captureImage(r.lima.instance("vm1"), {
      outputPath: r.outputPath,
      format: "raw",
      qemuImg: r.qemuImg,
    });
    assertEquals(
      r.fakeQemu.commandLines()[1],
      [
        "qemu-img convert -f qcow2 -O raw",
        `${r.diskPath} ${r.outputPath}.tmp`,
      ].join(" "),
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("qcow2 capture without qemu-img throws QemuImgMissingError (after stop, before convert)", async () => {
  const r = await rig(new Uint8Array(16));
  try {
    r.fakeQemu.available = false;
    await assertRejects(
      () =>
        captureImage(r.lima.instance("vm1"), {
          outputPath: r.outputPath,
          qemuImg: r.qemuImg,
        }),
      QemuImgMissingError,
    );
    // The stop happened; nothing was written.
    assertEquals(r.fakeLima.commandLines(), [
      "limactl list --json",
      "limactl stop vm1",
    ]);
    await assertRejects(() => Deno.stat(r.outputPath));
  } finally {
    await cleanup(r);
  }
});

Deno.test("Running + stop:false is refused", async () => {
  const r = await rig(new Uint8Array(16));
  try {
    const error = await assertRejects(
      () =>
        captureImage(r.lima.instance("vm1"), {
          outputPath: r.outputPath,
          stop: false,
          qemuImg: r.qemuImg,
        }),
      ImageCaptureError,
    );
    assertStringIncludes(error.message, "running");
    assertEquals(r.fakeLima.commandLines(), ["limactl list --json"]);
  } finally {
    await cleanup(r);
  }
});

Deno.test("Broken instances and absent instances are refused", async () => {
  const r = await rig(new Uint8Array(16));
  try {
    r.fakeLima.setInstance("vm1", { status: "Broken" });
    await assertRejects(
      () =>
        captureImage(r.lima.instance("vm1"), {
          outputPath: r.outputPath,
          qemuImg: r.qemuImg,
        }),
      ImageCaptureError,
      "Broken",
    );
    await assertRejects(
      () =>
        captureImage(r.lima.instance("ghost"), {
          outputPath: r.outputPath,
          qemuImg: r.qemuImg,
        }),
      ImageCaptureError,
      "does not exist",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("an ASIF disk is detected and refused", async () => {
  const r = await rig(ASIF_MAGIC);
  try {
    await assertRejects(
      () =>
        captureImage(r.lima.instance("vm1"), {
          outputPath: r.outputPath,
          qemuImg: r.qemuImg,
        }),
      ImageCaptureError,
      "ASIF",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("a missing disk file explains the Lima 1.x limitation", async () => {
  const r = await rig(new Uint8Array(16));
  try {
    await Deno.remove(r.diskPath);
    await assertRejects(
      () =>
        captureImage(r.lima.instance("vm1"), {
          outputPath: r.outputPath,
          qemuImg: r.qemuImg,
        }),
      ImageCaptureError,
      "1.x",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("a failed convert removes the .tmp and rethrows", async () => {
  const r = await rig(new Uint8Array(16));
  try {
    r.fakeQemu.onConvert = (convert) => {
      Deno.writeTextFileSync(convert.dest, "PARTIAL");
      return { success: false, code: 1, stdout: "", stderr: "no space" };
    };
    r.fakeQemu.setImage(r.diskPath, { format: "raw" });
    await assertRejects(() =>
      captureImage(r.lima.instance("vm1"), {
        outputPath: r.outputPath,
        qemuImg: r.qemuImg,
      })
    );
    await assertRejects(() => Deno.stat(`${r.outputPath}.tmp`));
    await assertRejects(() => Deno.stat(r.outputPath));
  } finally {
    await cleanup(r);
  }
});
