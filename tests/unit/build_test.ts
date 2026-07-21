import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { QemuImg, QemuImgMissingError } from "@nullstyle/qemu-img";
import { FakeQemuImg } from "@nullstyle/qemu-img/testing";
import { Limactl } from "../../src/limactl.ts";
import { GuestExecError, WaitTimeoutError } from "../../src/errors.ts";
import { buildShellArgv, strictWrap, sudoWrap } from "../../src/shell.ts";
import type { CommandResult, CommandRunner } from "../../src/runner.ts";
import {
  failed,
  FakeLimactl,
  type GuestScriptCall,
  ok,
} from "../../testing/mod.ts";
import { buildImage, DEFAULT_SEAL_SCRIPT } from "../../src/image/build.ts";
import { ImageBuildError } from "../../src/image/errors.ts";
import type { ImageEvent } from "../../src/image/types.ts";

function shellLine(instance: string, script: string, sudo = false): string {
  const wrapped = strictWrap(script);
  const body = sudo ? sudoWrap(wrapped, { sudoBin: "sudo" }) : wrapped;
  return ["limactl", ...buildShellArgv(instance, body)].join(" ");
}

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

async function rig(name: string): Promise<Rig> {
  await Deno.mkdir("tests/.tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "tests/.tmp" });
  const diskPath = `${dir}/disk`;
  await Deno.writeFile(diskPath, new Uint8Array(64)); // raw (vz-style) disk
  const fakeLima = new FakeLimactl();
  // Pre-seed the builder so `limactl start` reuses it with a REAL dir the
  // capture stage can sniff (create-with-existing-name reuses, like limactl).
  fakeLima.setInstance(name, { status: "Running", dir, arch: "aarch64" });
  const fakeQemu = new FakeQemuImg();
  fakeQemu.setImage(diskPath, { format: "raw", virtualSizeBytes: 1024 });
  fakeQemu.onConvert = (convert) => {
    Deno.writeTextFileSync(convert.dest, "IMG");
  };
  return {
    dir,
    diskPath,
    outputPath: `${dir}/out.qcow2`,
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

Deno.test("happy path: pinned ledger from preflight to cleanup", async () => {
  const r = await rig("b1");
  try {
    let fnSaw = "";
    const image = await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: r.outputPath,
      name: "b1",
      steps: [
        { run: "apt-get update", sudo: true, comment: "refresh apt" },
        { fn: (vm) => void (fnSaw = vm.name) },
      ],
    }, {
      qemuImg: r.qemuImg,
      onEvent: (event) => r.events.push(event),
    });

    assertEquals(r.fakeLima.commandLines(), [
      "limactl start --name=b1 --cpus=2 --memory=2 --disk=10 --plain " +
      "--tty=false template:ubuntu-24.04",
      "limactl list --json", // waitReady status probe
      shellLine("b1", "true"), // waitReady guest probe
      shellLine("b1", "apt-get update", true), // step 0 (sudo)
      shellLine("b1", DEFAULT_SEAL_SCRIPT, true), // default seal
      "limactl list --json", // capture's info
      "limactl stop b1",
      "limactl delete -f b1",
    ]);
    assertEquals(r.fakeQemu.commandLines(), [
      "qemu-img --version", // buildImage's preflight (fail before boot)
      "qemu-img --version", // captureImage's own convert-tier check
      `qemu-img convert -f raw -c -O qcow2 ${r.diskPath} ${r.outputPath}.tmp`,
      `qemu-img info --output=json ${r.outputPath}.tmp`,
    ]);

    assertEquals(fnSaw, "b1");
    assertEquals(image.format, "qcow2");
    assertEquals(image.arch, "aarch64");
    assertEquals(image.virtualSizeBytes, 1024);

    const phases = r.events
      .filter((event) => event.type === "phase")
      .map((event) => event.phase);
    assertEquals(phases, [
      "preflight",
      "create",
      "wait-ready",
      "seal",
      "stop",
      "inspect",
      "convert",
      "digest",
      "cleanup",
    ]);
    const steps = r.events.filter((event) => event.type === "step");
    assertEquals(steps.length, 2);
    assertEquals(steps[0].comment, "refresh apt");
    assertEquals(steps[0].count, 2);
  } finally {
    await cleanup(r);
  }
});

Deno.test("copyIn steps route by mode/owner/group presence", async () => {
  const r = await rig("b2");
  try {
    const local = `${r.dir}/payload.txt`;
    await Deno.writeTextFile(local, "payload");
    await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: r.outputPath,
      name: "b2",
      seal: false,
      steps: [
        { copyIn: local, to: "/home/user/plain.txt" },
        { copyIn: local, to: "/etc/rooted.txt", mode: "0640" },
      ],
    }, { qemuImg: r.qemuImg });

    const lines = r.fakeLima.commandLines();
    assert(
      lines.includes(`limactl cp ${local} b2:/home/user/plain.txt`),
      "plain copyIn uses limactl cp directly",
    );
    // The root-owned delivery stages to a random path then installs:
    const staged = lines.find((line) =>
      line.startsWith(`limactl cp ${local} b2:/tmp/.lima-cp-`)
    );
    assert(staged !== undefined, "copyInAsRoot stages via limactl cp");
    const install = lines.find((line) =>
      line.includes("install -m 0640") && line.includes("/etc/rooted.txt")
    );
    assert(install !== undefined, "copyInAsRoot installs with the mode");
  } finally {
    await cleanup(r);
  }
});

Deno.test("seal: false skips sealing; a custom seal script is used verbatim", async () => {
  const r = await rig("b3");
  try {
    await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: r.outputPath,
      name: "b3",
      seal: false,
    }, { qemuImg: r.qemuImg });
    const noSeal = r.fakeLima.commandLines();
    assertEquals(
      noSeal.some((line) => line.includes("MUST(dist)")),
      false,
      "no seal script ran",
    );

    r.fakeLima.calls.length = 0;
    r.fakeLima.setInstance("b3", { status: "Running", dir: r.dir });
    await Deno.remove(r.outputPath);
    await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: r.outputPath,
      name: "b3",
      seal: { script: "echo custom-seal" },
    }, { qemuImg: r.qemuImg });
    assert(
      r.fakeLima.commandLines().includes(
        shellLine("b3", "echo custom-seal", true),
      ),
      "custom seal ran verbatim (sudo, strict)",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("a failing step wraps in ImageBuildError{provision, stepIndex} and still deletes", async () => {
  const r = await rig("b4");
  try {
    r.fakeLima.stub(
      (call) => call.args.join(" ").includes("boom-step"),
      { success: false, code: 7, stdout: "", stderr: "step exploded" },
    );
    const error = await assertRejects(
      () =>
        buildImage(r.lima, {
          base: { template: "ubuntu-24.04" },
          outputPath: r.outputPath,
          name: "b4",
          steps: [{ run: "echo boom-step" }],
        }, { qemuImg: r.qemuImg }),
      ImageBuildError,
    );
    assertEquals(error.phase, "provision");
    assertEquals(error.stepIndex, 0);
    assertEquals(error.kept, false);
    assertInstanceOf(error.cause, GuestExecError);
    const lines = r.fakeLima.commandLines();
    assertEquals(lines[lines.length - 1], "limactl delete -f b4");
  } finally {
    await cleanup(r);
  }
});

Deno.test("keepOnFailure keeps the builder VM and says so", async () => {
  const r = await rig("b5");
  try {
    r.fakeLima.stub(
      (call) => call.args.join(" ").includes("boom-step"),
      { success: false, code: 1, stdout: "", stderr: "" },
    );
    const error = await assertRejects(
      () =>
        buildImage(r.lima, {
          base: { template: "ubuntu-24.04" },
          outputPath: r.outputPath,
          name: "b5",
          steps: [{ run: "echo boom-step" }],
        }, { qemuImg: r.qemuImg, keepOnFailure: true }),
      ImageBuildError,
    );
    assertEquals(error.kept, true);
    assertStringIncludes(error.message, "kept for debugging");
    assertEquals(
      r.fakeLima.commandLines().some((line) =>
        line.startsWith("limactl delete")
      ),
      false,
      "no delete was issued",
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("qcow2 preflight fails before any limactl call when qemu-img is missing", async () => {
  const r = await rig("b6");
  try {
    r.fakeQemu.available = false;
    const error = await assertRejects(
      () =>
        buildImage(r.lima, {
          base: { template: "ubuntu-24.04" },
          outputPath: r.outputPath,
          name: "b6",
        }, { qemuImg: r.qemuImg }),
      ImageBuildError,
    );
    assertEquals(error.phase, "preflight");
    assertInstanceOf(error.cause, QemuImgMissingError);
    assertEquals(r.fakeLima.calls.length, 0, "no VM was ever created");
  } finally {
    await cleanup(r);
  }
});

Deno.test("raw builds skip the qemu-img preflight entirely", async () => {
  const r = await rig("b7");
  try {
    r.fakeQemu.available = false;
    const cpRunner: CommandRunner = {
      run(_bin, args): Promise<CommandResult> {
        Deno.copyFileSync(args[args.length - 2], args[args.length - 1]);
        return Promise.resolve(ok());
      },
    };
    const image = await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: `${r.dir}/out.raw`,
      format: "raw",
      name: "b7",
      seal: false,
    }, { qemuImg: r.qemuImg, runner: cpRunner });
    assertEquals(image.format, "raw");
    assertEquals(r.fakeQemu.calls.length, 0, "qemu-img never invoked");
  } finally {
    await cleanup(r);
  }
});

Deno.test("cross-arch without vmType qemu is refused in preflight", async () => {
  const r = await rig("b8");
  try {
    const foreign = Deno.build.arch === "aarch64" ? "x86_64" : "aarch64";
    const error = await assertRejects(
      () =>
        buildImage(r.lima, {
          base: { template: "ubuntu-24.04" },
          outputPath: r.outputPath,
          arch: foreign,
          name: "b8",
        }, { qemuImg: r.qemuImg }),
      ImageBuildError,
    );
    assertEquals(error.phase, "preflight");
    assertStringIncludes(String(error.cause), "cross-arch");
    assertEquals(r.fakeLima.calls.length, 0);
  } finally {
    await cleanup(r);
  }
});

Deno.test("cross-arch with vmType qemu emits --arch and --vm-type", async () => {
  const r = await rig("b9");
  try {
    const foreign = Deno.build.arch === "aarch64" ? "x86_64" : "aarch64";
    await buildImage(r.lima, {
      base: { template: "ubuntu-24.04" },
      outputPath: r.outputPath,
      arch: foreign,
      name: "b9",
      seal: false,
      create: { vmType: "qemu" },
    }, { qemuImg: r.qemuImg });
    assertStringIncludes(
      r.fakeLima.commandLines()[0],
      `--vm-type=qemu --arch=${foreign} --cpus=2 --memory=2 --disk=10 --plain`,
    );
  } finally {
    await cleanup(r);
  }
});

Deno.test("caller waitReady options win over the cross-arch default (and wait-ready wraps)", async () => {
  // A fake whose readiness probe ("true") ALWAYS fails: waitReady must hit
  // its deadline, and reporting "after 1ms" proves the caller's 1ms beat the
  // 30-minute cross-arch default.
  class NeverReadyFake extends FakeLimactl {
    protected override onGuestScript(
      call: GuestScriptCall,
    ): CommandResult | undefined {
      return call.script === "true" ? failed(1) : undefined;
    }
  }
  await Deno.mkdir("tests/.tmp", { recursive: true });
  const dir = await Deno.makeTempDir({ dir: "tests/.tmp" });
  try {
    const fakeLima = new NeverReadyFake();
    fakeLima.setInstance("b10", { status: "Running", dir });
    const fakeQemu = new FakeQemuImg();
    const foreign = Deno.build.arch === "aarch64" ? "x86_64" : "aarch64";
    const error = await assertRejects(
      () =>
        buildImage(new Limactl({ runner: fakeLima }), {
          base: { template: "ubuntu-24.04" },
          outputPath: `${dir}/out.qcow2`,
          arch: foreign,
          name: "b10",
          create: { vmType: "qemu" },
        }, {
          qemuImg: new QemuImg({ runner: fakeQemu }),
          waitReady: { timeoutMs: 1, intervalMs: 1 },
        }),
      ImageBuildError,
    );
    assertEquals(error.phase, "wait-ready");
    assertInstanceOf(error.cause, WaitTimeoutError);
    assertStringIncludes(String(error.cause), "after 1ms");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cleanup failure surfaces as ImageBuildError{cleanup} with the image already written", async () => {
  const r = await rig("b11");
  try {
    r.fakeLima.stub(
      (call) => call.args[0] === "delete",
      { success: false, code: 1, stdout: "", stderr: "delete refused" },
    );
    const error = await assertRejects(
      () =>
        buildImage(r.lima, {
          base: { template: "ubuntu-24.04" },
          outputPath: r.outputPath,
          name: "b11",
          seal: false,
        }, { qemuImg: r.qemuImg }),
      ImageBuildError,
    );
    assertEquals(error.phase, "cleanup");
    assertEquals(await Deno.readTextFile(r.outputPath), "IMG");
  } finally {
    await cleanup(r);
  }
});
