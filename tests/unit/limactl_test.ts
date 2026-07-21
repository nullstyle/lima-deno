import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { LimaVersionError } from "../../src/errors.ts";
import { Limactl } from "../../src/limactl.ts";
import { failed, FakeLimactl } from "../../testing/fake_limactl.ts";

function client(): { lima: Limactl; fake: FakeLimactl } {
  const fake = new FakeLimactl();
  return { lima: new Limactl({ runner: fake }), fake };
}

Deno.test("create from a template file emits the proven studiobox argv", async () => {
  const { lima, fake } = client();
  await lima.create("studiobox-host-aarch64", { file: "/tmp/host.yaml" });
  assertEquals(fake.commandLines(), [
    "limactl start --name=studiobox-host-aarch64 --tty=false /tmp/host.yaml",
  ]);
});

Deno.test("create from a template name emits the proven tools-driver argv", async () => {
  const { lima, fake } = client();
  await lima.create("fc-smoke", { template: "ubuntu-24.04" }, {
    vmType: "vz",
    nestedVirtualization: true,
  });
  assertEquals(fake.commandLines(), [
    "limactl start --name=fc-smoke --vm-type=vz --nested-virt --tty=false template:ubuntu-24.04",
  ]);
});

Deno.test("a template: prefixed name is passed through unchanged", async () => {
  const { lima, fake } = client();
  await lima.create("vm", { template: "template:debian-12" });
  assertStringIncludes(fake.commandLines()[0]!, " template:debian-12");
});

Deno.test("create from a typed config pipes rendered YAML via stdin '-'", async () => {
  const { lima, fake } = client();
  await lima.create("cfg", {
    config: { vmType: "vz", cpus: 2, mounts: [] },
  });
  const call = fake.calls[0]!;
  assertEquals(call.args.at(-1), "-");
  assertEquals(call.stdin, "vmType: vz\ncpus: 2\nmounts: []\n");
  assertEquals(fake.instances.get("cfg")?.configYaml, call.stdin);
});

Deno.test("create from raw yaml pipes it verbatim via stdin '-'", async () => {
  const { lima, fake } = client();
  await lima.create("raw", { yaml: "vmType: qemu\n" });
  assertEquals(fake.calls[0]!.stdin, "vmType: qemu\n");
});

Deno.test("remaining create flags map to their limactl spellings", async () => {
  const { lima, fake } = client();
  await lima.create("kitchen", { url: "https://example.com/t.yaml" }, {
    rosetta: true,
    cpus: 8,
    memoryGiB: 16,
    diskGiB: 100,
    mounts: ["/src", "/data:w"],
    network: "lima:shared",
    plain: true,
    set: [".ssh.localPort = 2222"],
  });
  assertEquals(fake.commandLines(), [
    "limactl start --name=kitchen --rosetta --cpus=8 --memory=16 --disk=100 " +
    "--mount=/src --mount=/data:w --network=lima:shared --plain " +
    "--set=.ssh.localPort = 2222 --tty=false https://example.com/t.yaml",
  ]);
});

Deno.test("creating with an existing name reuses and boots it (real limactl behavior)", async () => {
  const { lima, fake } = client();
  fake.setInstance("dupe", { status: "Stopped" });
  const vm = await lima.create("dupe", { template: "ubuntu-24.04" });
  assertEquals(fake.instances.get("dupe")?.status, "Running");
  assertEquals(vm.name, "dupe");
});

Deno.test("available() is true when --version succeeds, false when it fails", async () => {
  const { lima, fake } = client();
  assert(await lima.available());
  fake.stub((call) => call.args[0] === "--version", failed(1));
  assertEquals(await lima.available(), false);
});

Deno.test("version() parses; requireVersion enforces the 2.1.0 floor", async () => {
  const { lima, fake } = client();
  fake.versionOutput = "limactl version 2.1.4";
  assertEquals((await lima.version()).raw, "2.1.4");
  assertEquals((await lima.requireVersion()).raw, "2.1.4");
  fake.versionOutput = "limactl version 1.2.1";
  const error = await assertRejects(
    () => lima.requireVersion(),
    LimaVersionError,
  );
  assertEquals(error.found?.raw, "1.2.1");
  assertEquals(error.minimum, "2.1.0");
});

Deno.test("requireVersion accepts an explicit floor", async () => {
  const { lima, fake } = client();
  fake.versionOutput = "limactl version 1.0.4";
  await assertRejects(() => lima.requireVersion("1.1.0"), LimaVersionError);
});

Deno.test("list/listNames/get/exists reflect fake state and argv", async () => {
  const { lima, fake } = client();
  fake.setInstance("one", { status: "Stopped" });
  fake.setInstance("two");
  assertEquals(await lima.listNames(), ["one", "two"]);
  assertEquals((await lima.list()).map((i) => i.status), [
    "Stopped",
    "Running",
  ]);
  assertEquals((await lima.get("one"))?.status, "Stopped");
  assertEquals(await lima.get("three"), undefined);
  assert(await lima.exists("two"));
  assertEquals(await lima.exists("three"), false);
  assertEquals(fake.commandLines(), [
    "limactl list -q",
    "limactl list --json",
    "limactl list --json",
    "limactl list --json",
    "limactl list -q",
    "limactl list -q",
  ]);
});

Deno.test("disk lifecycle: create/ls/resize/delete argv and state", async () => {
  const { lima, fake } = client();
  await lima.diskCreate("data", { size: "10GiB", format: "raw" });
  const disks = await lima.diskList();
  assertEquals(disks.length, 1);
  assertEquals(disks[0]!.name, "data");
  await lima.diskResize("data", "20GiB");
  assertEquals(fake.disks.get("data")?.size, "20GiB");
  await lima.diskDelete("data");
  assertEquals(fake.disks.size, 0);
  assertEquals(fake.commandLines(), [
    "limactl disk create data --size=10GiB --format=raw",
    "limactl disk ls --json",
    "limactl disk resize data --size=20GiB",
    "limactl disk delete data",
  ]);
});

Deno.test("raw() passes argv through the seam and records it", async () => {
  const { lima, fake } = client();
  fake.stub((call) => call.args[0] === "info", failed(7, "no info here"));
  const result = await lima.raw(["info"]);
  assertEquals(result.code, 7);
  assertEquals(fake.commandLines(), ["limactl info"]);
});
