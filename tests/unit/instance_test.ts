import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { CommandError } from "../../src/runner.ts";
import { strictWrap, sudoWrap } from "../../src/shell.ts";
import {
  GuestExecError,
  InstanceBrokenError,
  WaitTimeoutError,
} from "../../src/errors.ts";
import { LIMA_CP_STAGING_PREFIX, LimaInstance } from "../../src/instance.ts";
import {
  failed,
  FakeLimactl,
  type GuestScriptCall,
  ok,
} from "../../testing/fake_limactl.ts";

function handle(
  name = "vm1",
  fake = new FakeLimactl(),
): { vm: LimaInstance; fake: FakeLimactl } {
  fake.setInstance(name);
  return { vm: new LimaInstance(name, { runner: fake }), fake };
}

Deno.test("exists uses `list -q` membership with trimmed lines", async () => {
  const { vm, fake } = handle();
  assert(await vm.exists());
  assertEquals(fake.commandLines(), ["limactl list -q"]);
  const absent = new LimaInstance("ghost", { runner: fake });
  assertEquals(await absent.exists(), false);
});

Deno.test("isRunning uses the proven `list --format` text probe", async () => {
  const { vm, fake } = handle();
  assert(await vm.isRunning());
  assertEquals(fake.commandLines(), [
    "limactl list --format {{.Name}}\t{{.Status}}",
  ]);
  fake.instances.get("vm1")!.status = "Stopped";
  assertEquals(await vm.isRunning(), false);
  const absent = new LimaInstance("ghost", { runner: fake });
  assertEquals(await absent.isRunning(), false);
});

Deno.test("info/status parse `list --json` for this instance", async () => {
  const { vm, fake } = handle();
  fake.instances.get("vm1")!.errors = ["boom"];
  fake.instances.get("vm1")!.status = "Broken";
  const info = await vm.info();
  assertEquals(info?.status, "Broken");
  assertEquals(info?.errors, ["boom"]);
  assertEquals(await vm.status(), "Broken");
  const absent = new LimaInstance("ghost", { runner: fake });
  assertEquals(await absent.info(), undefined);
  assertEquals(await absent.status(), undefined);
});

Deno.test("lifecycle verbs emit the proven argv", async () => {
  const { vm, fake } = handle();
  await vm.start();
  await vm.stop();
  await vm.start();
  await vm.stop({ force: true });
  await vm.restart();
  await vm.factoryReset();
  await vm.protect();
  await vm.unprotect();
  await vm.delete();
  assertEquals(fake.commandLines(), [
    "limactl start vm1",
    "limactl stop vm1",
    "limactl start vm1",
    "limactl stop -f vm1",
    "limactl restart vm1",
    "limactl factory-reset vm1",
    "limactl protect vm1",
    "limactl unprotect vm1",
    "limactl delete -f vm1",
  ]);
  assertEquals(fake.instances.size, 0);
});

Deno.test("delete force:false omits -f and is refused while Running", async () => {
  const { vm, fake } = handle();
  await assertRejects(() => vm.delete({ force: false }), CommandError);
  await vm.stop();
  await vm.delete({ force: false });
  assertEquals(fake.commandLines(), [
    "limactl delete vm1",
    "limactl stop vm1",
    "limactl delete vm1",
  ]);
  assertEquals(fake.instances.size, 0);
});

Deno.test("a protected instance refuses deletion until unprotected", async () => {
  const { vm } = handle();
  await vm.protect();
  await assertRejects(() => vm.delete(), CommandError);
  await vm.unprotect();
  await vm.delete();
});

Deno.test("plain stop of a non-Running instance fails; stop -f succeeds", async () => {
  const { vm, fake } = handle();
  fake.instances.get("vm1")!.status = "Stopped";
  await assertRejects(() => vm.stop(), CommandError);
  await vm.stop({ force: true });
});

Deno.test("exec emits the proven strict-wrapped bash argv", async () => {
  const { vm, fake } = handle();
  const result = await vm.exec("echo hi");
  assertEquals(fake.calls[0]!.args, [
    "shell",
    "vm1",
    "--",
    "bash",
    "-lc",
    "set -euo pipefail; echo hi",
  ]);
  assertEquals(result.instance, "vm1");
  assertEquals(result.script, "echo hi");
  assert(result.success);
});

Deno.test("exec sudo wraps with the proven quoting, quotes round-trip", async () => {
  const captured: GuestScriptCall[] = [];
  class Capturing extends FakeLimactl {
    protected override onGuestScript(call: GuestScriptCall) {
      captured.push(call);
      return ok();
    }
  }
  const fake = new Capturing();
  const { vm } = handle("vm1", fake);
  await vm.exec(`echo 'quoted'`, { sudo: true });
  assertEquals(
    fake.calls[0]!.args.at(-1),
    `sudo -E bash -lc 'set -euo pipefail; echo '\\''quoted'\\'''`,
  );
  assertEquals(captured[0]!.sudo, true);
  assertEquals(captured[0]!.script, `echo 'quoted'`);
});

Deno.test("exec user implies sudo -u; env exports precede the script; strict:false skips the wrap", async () => {
  const { vm, fake } = handle();
  await vm.exec("whoami", { user: "app", env: { FOO: "bar baz" } });
  assertEquals(
    fake.calls[0]!.args.at(-1),
    `sudo -E -u app bash -lc 'set -euo pipefail; export FOO='\\''bar baz'\\''; whoami'`,
  );
  await vm.exec("echo raw", { strict: false });
  assertEquals(fake.calls[1]!.args.at(-1), "echo raw");
});

Deno.test("exec workdir threads to limactl shell --workdir", async () => {
  const { vm, fake } = handle();
  await vm.exec("pwd", { workdir: "/srv" });
  assertEquals(fake.calls[0]!.args.slice(0, 4), [
    "shell",
    "--workdir",
    "/srv",
    "vm1",
  ]);
});

Deno.test("exec check:true throws GuestExecError with guest context", async () => {
  const { vm, fake } = handle();
  fake.stub(
    (call) => call.args[0] === "shell",
    failed(3, "guest exploded"),
  );
  const error = await assertRejects(
    () => vm.exec("boom-script", { check: true }),
    GuestExecError,
  );
  assertEquals(error.instance, "vm1");
  assertEquals(error.script, "boom-script");
  assertEquals(error.code, 3);
  assertStringIncludes(error.message, "vm1");
  const unchecked = await vm.exec("boom-script");
  assert(unchecked.success); // stub fired once; nonzero without check resolves
});

Deno.test("command runs a raw argv with no bash wrapping", async () => {
  const { vm, fake } = handle();
  await vm.command(["uname", "-a"]);
  assertEquals(fake.calls[0]!.args, ["shell", "vm1", "--", "uname", "-a"]);
});

Deno.test("copyIn/copyOut argv; copyOut of a missing guest path fails", async () => {
  const { vm, fake } = handle();
  await vm.copyIn("/tmp/local.txt", "/tmp/remote.txt");
  await vm.copyOut("/tmp/remote.txt", "/tmp/back.txt");
  await vm.copyIn("/tmp/dir", "/tmp/dir2", { recursive: true });
  assertEquals(fake.commandLines(), [
    "limactl cp /tmp/local.txt vm1:/tmp/remote.txt",
    "limactl cp vm1:/tmp/remote.txt /tmp/back.txt",
    "limactl cp -r /tmp/dir vm1:/tmp/dir2",
  ]);
  await assertRejects(
    () => vm.copyOut("/nope/missing", "/tmp/x"),
    CommandError,
  );
});

Deno.test("copyInAsRoot stages, sudo-installs with mode, and cleans up", async () => {
  const { vm, fake } = handle();
  await vm.copyInAsRoot("/tmp/token", "/etc/svc/token", { mode: "0640" });
  const [cp, shell] = fake.calls;
  assertEquals(cp!.args[0], "cp");
  const staged = (cp!.args[2] as string).split(":")[1]!;
  assert(staged.startsWith(LIMA_CP_STAGING_PREFIX));
  const body = shell!.args.at(-1) as string;
  assertEquals(
    body,
    sudoWrap(
      strictWrap(
        `install -m 0640 '${staged}' '/etc/svc/token' && rm -f '${staged}'`,
      ),
    ),
  );
  const files = fake.guestFilesFor("vm1");
  assert(files.has("/etc/svc/token"));
  assertEquals(files.has(staged), false);
});

Deno.test("copyInAsRoot honors owner/group and a custom staging prefix", async () => {
  const { vm, fake } = handle();
  await vm.copyInAsRoot("/tmp/f", "/etc/f", {
    owner: "root",
    group: "svc",
    stagingPrefix: "/tmp/.custom-",
  });
  const staged = (fake.calls[0]!.args[2] as string).split(":")[1]!;
  assert(staged.startsWith("/tmp/.custom-"));
  assertEquals(
    fake.calls[1]!.args.at(-1) as string,
    sudoWrap(
      strictWrap(
        `install -m 0600 -o root -g svc '${staged}' '/etc/f' && rm -f '${staged}'`,
      ),
    ),
  );
});

Deno.test("waitReady resolves once the probe passes", async () => {
  const { vm, fake } = handle();
  fake.stub((call) => call.args[0] === "shell", failed(1));
  fake.stub((call) => call.args[0] === "shell", failed(1));
  await vm.waitReady({ intervalMs: 1, timeoutMs: 1_000 });
  const probes = fake.calls.filter((call) => call.args[0] === "shell");
  assertEquals(probes.length, 3);
});

Deno.test("waitReady fails fast on Broken with limactl's diagnostics", async () => {
  const { vm, fake } = handle();
  fake.instances.get("vm1")!.status = "Broken";
  fake.instances.get("vm1")!.errors = ["hostagent gone"];
  const error = await assertRejects(
    () => vm.waitReady({ intervalMs: 1, timeoutMs: 100 }),
    InstanceBrokenError,
  );
  assertEquals(error.errors, ["hostagent gone"]);
});

Deno.test("waitReady times out with the last probe result attached", async () => {
  class NeverReady extends FakeLimactl {
    protected override onGuestScript(_call: GuestScriptCall) {
      return failed(1, "not yet");
    }
  }
  const fake = new NeverReady();
  const { vm } = handle("vm1", fake);
  const error = await assertRejects(
    () => vm.waitReady({ intervalMs: 5, timeoutMs: 30 }),
    WaitTimeoutError,
  );
  assertEquals(error.instance, "vm1");
  assertEquals(error.lastResult?.stderr, "not yet");
});

Deno.test("waitReady with a pre-aborted signal rejects instead of sleeping", async () => {
  class NeverReady extends FakeLimactl {
    protected override onGuestScript(_call: GuestScriptCall) {
      return failed(1, "not yet");
    }
  }
  const fake = new NeverReady();
  const { vm } = handle("vm1", fake);
  const controller = new AbortController();
  const reason = new Error("caller gave up");
  controller.abort(reason);
  const error = await assertRejects(() =>
    vm.waitReady({
      intervalMs: 5,
      timeoutMs: 10_000,
      signal: controller.signal,
    })
  );
  assertEquals(error, reason);
});

Deno.test("snapshot namespace emits the limactl snapshot argv", async () => {
  const { vm, fake } = handle();
  await vm.snapshot.create({ tag: "clean" });
  assertEquals(await vm.snapshot.list(), "clean\n");
  await vm.snapshot.apply({ tag: "clean" });
  await vm.snapshot.delete({ tag: "clean" });
  await assertRejects(() => vm.snapshot.apply({ tag: "clean" }), CommandError);
  assertEquals(fake.commandLines().slice(0, 4), [
    "limactl snapshot create vm1 --tag clean",
    "limactl snapshot list vm1",
    "limactl snapshot apply vm1 --tag clean",
    "limactl snapshot delete vm1 --tag clean",
  ]);
});
