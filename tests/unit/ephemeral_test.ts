import { assertEquals, assertRejects } from "@std/assert";
import { Limactl } from "../../src/limactl.ts";
import { withInstance } from "../../src/ephemeral.ts";
import { buildShellArgv, strictWrap } from "../../src/shell.ts";
import { failed, FakeLimactl } from "../../testing/mod.ts";

function shellLine(instance: string, script: string): string {
  return ["limactl", ...buildShellArgv(instance, strictWrap(script))].join(" ");
}

function rig(): { fake: FakeLimactl; lima: Limactl } {
  const fake = new FakeLimactl();
  return { fake, lima: new Limactl({ runner: fake }) };
}

Deno.test("withInstance creates, waits, runs, and deletes", async () => {
  const { fake, lima } = rig();
  const seen = await withInstance(
    lima,
    "t",
    { template: "ubuntu-24.04" },
    async (vm) => (await vm.exec("echo hi")).stdout,
  );
  assertEquals(typeof seen, "string");
  assertEquals(fake.commandLines(), [
    "limactl start --name=t --tty=false template:ubuntu-24.04",
    "limactl list --json", // waitReady status probe
    shellLine("t", "true"), // waitReady guest probe
    shellLine("t", "echo hi"), // the body
    "limactl delete -f t",
  ]);
});

Deno.test("keepOnSuccess leaves the instance in place", async () => {
  const { fake, lima } = rig();
  await withInstance(lima, "t", { template: "u" }, () => {}, {
    keepOnSuccess: true,
    waitReady: false,
  });
  assertEquals(fake.commandLines(), [
    "limactl start --name=t --tty=false template:u",
  ]);
});

Deno.test("waitReady: false skips the readiness probes", async () => {
  const { fake, lima } = rig();
  await withInstance(lima, "t", { template: "u" }, () => {}, {
    waitReady: false,
  });
  assertEquals(fake.commandLines(), [
    "limactl start --name=t --tty=false template:u",
    "limactl delete -f t",
  ]);
});

Deno.test("a throwing body still deletes, and the original error wins", async () => {
  const { fake, lima } = rig();
  // Even when cleanup itself fails, the body's error is what escapes.
  fake.stub((call) => call.args[0] === "delete", failed(1, "delete boom"));
  const error = await assertRejects(
    () =>
      withInstance(lima, "t", { template: "u" }, () => {
        throw new Error("body boom");
      }, { waitReady: false }),
    Error,
    "body boom",
  );
  assertEquals(error.message, "body boom");
  assertEquals(fake.commandLines().at(-1), "limactl delete -f t");
});

Deno.test("keepOnFailure leaves the instance for debugging", async () => {
  const { fake, lima } = rig();
  await assertRejects(
    () =>
      withInstance(lima, "t", { template: "u" }, () => {
        throw new Error("body boom");
      }, { waitReady: false, keepOnFailure: true }),
    Error,
    "body boom",
  );
  assertEquals(fake.commandLines(), [
    "limactl start --name=t --tty=false template:u",
  ]);
});

Deno.test("a failed create deletes nothing — ownership never established", async () => {
  const { fake, lima } = rig();
  fake.stub((call) => call.args[0] === "start", failed(1, "start boom"));
  await assertRejects(() =>
    withInstance(lima, "t", { template: "u" }, () => {}, { waitReady: false })
  );
  assertEquals(
    fake.commandLines().filter((line) => line.includes("delete")),
    [],
  );
});

Deno.test("CreateOptions pass through to limactl start flags", async () => {
  const { fake, lima } = rig();
  await withInstance(lima, "t", { template: "u" }, () => {}, {
    waitReady: false,
    cpus: 4,
    memoryGiB: 8,
  });
  assertEquals(
    fake.commandLines()[0],
    "limactl start --name=t --cpus=4 --memory=8 --tty=false template:u",
  );
});
