import { assert, assertEquals } from "@std/assert";
import { parseInstanceList } from "../../src/status.ts";
import { strictWrap, sudoWrap } from "../../src/shell.ts";
import {
  failed,
  FakeLimactl,
  type GuestScriptCall,
  ok,
} from "../../testing/fake_limactl.ts";

Deno.test("start creates via --name flag and boots via bare name; duplicates fail", async () => {
  const fake = new FakeLimactl();
  const create = await fake.run("limactl", [
    "start",
    "--name=a",
    "--tty=false",
    "template:ubuntu-24.04",
  ]);
  assert(create.success);
  assertEquals(fake.instances.get("a")?.status, "Running");
  await fake.run("limactl", ["stop", "a"]);
  assertEquals(fake.instances.get("a")?.status, "Stopped");
  assert((await fake.run("limactl", ["start", "a"])).success);
  assertEquals(fake.instances.get("a")?.status, "Running");
  const dupe = await fake.run("limactl", [
    "start",
    "--name=a",
    "--tty=false",
    "x",
  ]);
  assertEquals(dupe.success, false);
  const ghost = await fake.run("limactl", ["start", "ghost"]);
  assertEquals(ghost.success, false);
});

Deno.test("list --json output round-trips through parseInstanceList", async () => {
  const fake = new FakeLimactl();
  fake.setInstance("one", {
    status: "Broken",
    errors: ["bad"],
    vmType: "qemu",
  });
  const result = await fake.run("limactl", ["list", "--json"]);
  const [info] = parseInstanceList(result.stdout);
  assertEquals(info!.name, "one");
  assertEquals(info!.status, "Broken");
  assertEquals(info!.errors, ["bad"]);
  assertEquals(info!.vmType, "qemu");
});

Deno.test("shell decodes sudo/strict wrapping via the library grammar", async () => {
  const captured: GuestScriptCall[] = [];
  class Capturing extends FakeLimactl {
    protected override onGuestScript(call: GuestScriptCall) {
      captured.push(call);
      return ok("captured");
    }
  }
  const fake = new Capturing();
  fake.setInstance("vm");
  const body = sudoWrap(strictWrap(`echo 'tricky quote'`), { user: "app" });
  const result = await fake.run("limactl", [
    "shell",
    "--workdir",
    "/srv",
    "vm",
    "--",
    "bash",
    "-lc",
    body,
  ]);
  assertEquals(result.stdout, "captured");
  assertEquals(captured[0]!.instance, "vm");
  assertEquals(captured[0]!.sudo, true);
  assertEquals(captured[0]!.user, "app");
  assertEquals(captured[0]!.workdir, "/srv");
  assertEquals(captured[0]!.script, `echo 'tricky quote'`);
});

Deno.test("shell against a missing instance fails", async () => {
  const fake = new FakeLimactl();
  const result = await fake.run("limactl", [
    "shell",
    "ghost",
    "--",
    "bash",
    "-lc",
    "true",
  ]);
  assertEquals(result.success, false);
});

Deno.test("built-in guest semantics: test -f and the install staging dance", async () => {
  const fake = new FakeLimactl();
  fake.setInstance("vm");
  const miss = await fake.run("limactl", [
    "shell",
    "vm",
    "--",
    "bash",
    "-lc",
    "set -euo pipefail; test -f /etc/token",
  ]);
  assertEquals(miss.success, false);
  await fake.run("limactl", ["cp", "/local", "vm:/tmp/.lima-cp-1"]);
  const install = await fake.run("limactl", [
    "shell",
    "vm",
    "--",
    "bash",
    "-lc",
    sudoWrap(
      strictWrap(
        `install -m 0600 '/tmp/.lima-cp-1' '/etc/token' && rm -f '/tmp/.lima-cp-1'`,
      ),
    ),
  ]);
  assert(install.success);
  const hit = await fake.run("limactl", [
    "shell",
    "vm",
    "--",
    "bash",
    "-lc",
    "set -euo pipefail; test -f /etc/token",
  ]);
  assert(hit.success);
  const unstagedInstall = await fake.run("limactl", [
    "shell",
    "vm",
    "--",
    "bash",
    "-lc",
    `set -euo pipefail; install -m 0600 '/tmp/.lima-cp-2' '/etc/x' && rm -f '/tmp/.lima-cp-2'`,
  ]);
  assertEquals(unstagedInstall.success, false);
});

Deno.test("cp: in records guest files; out of a missing path fails; missing instance fails", async () => {
  const fake = new FakeLimactl();
  fake.setInstance("vm");
  assert((await fake.run("limactl", ["cp", "/l", "vm:/g"])).success);
  assert(fake.guestFilesFor("vm").has("/g"));
  assert((await fake.run("limactl", ["cp", "vm:/g", "/back"])).success);
  assertEquals(
    (await fake.run("limactl", ["cp", "vm:/absent", "/back"])).success,
    false,
  );
  assertEquals(
    (await fake.run("limactl", ["cp", "/l", "ghost:/g"])).success,
    false,
  );
});

Deno.test("factory-reset stops the instance and clears guest files", async () => {
  const fake = new FakeLimactl();
  fake.setInstance("vm");
  fake.guestFilesFor("vm").add("/etc/thing");
  await fake.run("limactl", ["factory-reset", "vm"]);
  assertEquals(fake.instances.get("vm")?.status, "Stopped");
  assertEquals(fake.guestFilesFor("vm").size, 0);
});

Deno.test("stubs fire once, before the state machine", async () => {
  const fake = new FakeLimactl();
  fake.setInstance("vm");
  fake.stub((call) => call.args[0] === "stop", failed(9, "flaky"));
  assertEquals((await fake.run("limactl", ["stop", "vm"])).code, 9);
  assertEquals(fake.instances.get("vm")?.status, "Running"); // stub bypassed state
  assert((await fake.run("limactl", ["stop", "vm"])).success);
  assertEquals(fake.instances.get("vm")?.status, "Stopped");
});

Deno.test("non-limactl bins default to ok and are recorded; hook can override", async () => {
  class GitAware extends FakeLimactl {
    protected override onCommand(call: { readonly bin: string }) {
      return call.bin === "git" ? ok("file-a\nfile-b\n") : undefined;
    }
  }
  const fake = new GitAware();
  assertEquals(
    (await fake.run("git", ["ls-files"])).stdout,
    "file-a\nfile-b\n",
  );
  assert((await fake.run("tar", ["-czf", "x.tgz"])).success);
  assertEquals(fake.commandLines(), ["git ls-files", "tar -czf x.tgz"]);
});

Deno.test("version output is configurable; stdin is recorded", async () => {
  const fake = new FakeLimactl();
  fake.versionOutput = "limactl version 2.0.0";
  const version = await fake.run("limactl", ["--version"]);
  assertEquals(version.stdout, "limactl version 2.0.0\n");
  await fake.run("limactl", ["start", "--name=v", "--tty=false", "-"], {
    stdin: "vmType: vz\n",
  });
  assertEquals(fake.calls[1]!.stdin, "vmType: vz\n");
  assertEquals(fake.instances.get("v")?.configYaml, "vmType: vz\n");
});
