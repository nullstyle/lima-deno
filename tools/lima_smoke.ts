/**
 * Real-limactl smoke: boots an ephemeral Lima VM and exercises the library
 * surface end to end. Run manually before tagging a release:
 *
 *     deno task smoke
 *
 * Loud-skips (exit 0) when limactl is not installed. NOT run in CI — GitHub's
 * macOS runners cannot host vz VMs.
 *
 * Verifies the externally-unproven contracts specifically:
 * - the stdin `-` create form ({config} source);
 * - the `--nested-virt` flag spelling (via `start --help`, no M3 required);
 * - the copyInAsRoot stage+install pattern (mode check via `stat`);
 * - restart / stop / start cycles and waitReady.
 *
 * @module
 */

import { Limactl } from "../src/limactl.ts";
import { LIMA_COMPAT } from "../src/version.ts";

const step = (label: string) => console.log(`▸ ${label}`);
const pass = (label: string) => console.log(`✓ ${label}`);
const skip = (label: string) => console.log(`⊘ ${label}`);

const lima = new Limactl();

if (!(await lima.available())) {
  skip("Lima not installed (brew install lima) — smoke skipped");
  Deno.exit(0);
}

const version = await lima.requireVersion();
pass(`limactl ${version.raw} (compat window: >= ${LIMA_COMPAT.minimum})`);
if (version.raw !== LIMA_COMPAT.tested) {
  console.log(
    `  note: update LIMA_COMPAT.tested to "${version.raw}" in src/version.ts`,
  );
}

step("verify --nested-virt flag spelling via start --help");
const help = await lima.raw(["start", "--help"], { uncapped: true });
if (!help.stdout.includes("--nested-virt")) {
  console.error("✗ limactl start --help does not mention --nested-virt");
  Deno.exit(1);
}
pass("--nested-virt is a recognized limactl start flag");

const name = `lima-smoke-${Date.now().toString(36)}`;
step(`create ${name} from a typed config via stdin '-' (the unproven form)`);
const vm = await lima.create(name, {
  config: {
    base: "template://ubuntu-24.04",
    vmType: "vz",
    cpus: 2,
    memory: "2GiB",
    disk: "10GiB",
    mounts: [],
  },
}, { timeoutMs: 600_000 });

try {
  pass(`created ${name} (stdin template accepted)`);

  step("waitReady");
  await vm.waitReady({ timeoutMs: 120_000 });
  pass("guest answers");

  step("exec: plain, sudo, env, workdir");
  const uname = await vm.exec("uname -a", { check: true });
  console.log(`  ${uname.stdout.trim()}`);
  const whoami = await vm.exec("whoami", { check: true, sudo: true });
  if (whoami.stdout.trim() !== "root") throw new Error("sudo exec not root");
  const env = await vm.exec("echo $SMOKE_VAR", {
    check: true,
    env: { SMOKE_VAR: "it works" },
  });
  if (env.stdout.trim() !== "it works") throw new Error("env not threaded");
  const pwd = await vm.exec("pwd", { check: true, workdir: "/tmp" });
  if (pwd.stdout.trim() !== "/tmp") throw new Error("workdir not applied");
  pass("exec variants behave");

  step("copyIn → guest test -f → copyOut round-trip");
  const local = await Deno.makeTempFile({ prefix: "lima-smoke-" });
  await Deno.writeTextFile(local, "smoke payload\n");
  await vm.copyIn(local, "/tmp/smoke.txt");
  await vm.exec("test -f /tmp/smoke.txt", { check: true });
  const back = `${local}.back`;
  await vm.copyOut("/tmp/smoke.txt", back);
  if ((await Deno.readTextFile(back)) !== "smoke payload\n") {
    throw new Error("copyOut content mismatch");
  }
  await Deno.remove(local);
  await Deno.remove(back);
  pass("file transfer round-trips");

  step("copyInAsRoot: root-owned dest with explicit mode");
  const secret = await Deno.makeTempFile({ prefix: "lima-smoke-secret-" });
  await Deno.writeTextFile(secret, "s3cret\n");
  await vm.copyInAsRoot(secret, "/etc/lima-smoke-token", { mode: "0640" });
  const stat = await vm.exec("stat -c '%a %U' /etc/lima-smoke-token", {
    check: true,
    sudo: true,
  });
  if (stat.stdout.trim() !== "640 root") {
    throw new Error(`unexpected mode/owner: ${stat.stdout.trim()}`);
  }
  await vm.exec("rm -f /etc/lima-smoke-token", { check: true, sudo: true });
  await Deno.remove(secret);
  pass("stage + sudo install delivers root-owned files");

  step("stop → start → waitReady cycle");
  await vm.stop();
  await vm.start({ timeoutMs: 300_000 });
  await vm.waitReady({ timeoutMs: 120_000 });
  pass("lifecycle cycle survives");

  step("restart (verifies the limactl restart subcommand)");
  await vm.restart({ timeoutMs: 300_000 });
  await vm.waitReady({ timeoutMs: 120_000 });
  pass("restart works");

  step("snapshot on vz is expected to fail with limactl's own error");
  try {
    await vm.snapshot.create({ tag: "smoke" });
    console.log("  note: snapshot unexpectedly succeeded (qemu instance?)");
  } catch {
    pass("vz snapshot rejected by limactl (expected)");
  }

  step("typed status");
  const info = await vm.info();
  if (info?.status !== "Running") throw new Error("info() not Running");
  pass(`list --json parses (vmType=${info.vmType}, arch=${info.arch})`);

  console.log("\nsmoke: ALL GREEN");
} finally {
  step(`delete ${name}`);
  await vm.delete();
}
