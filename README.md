# @nullstyle/lima

> **Status: 0.1.0.** Pre-1.0 — breaking changes ride a minor bump.

Programmatic management of [Lima](https://lima-vm.io) VMs for Deno: create,
boot, probe, and destroy instances; run scripts in the guest; move files in and
out (including root-owned destinations); render typed, byte-deterministic Lima
templates; and test all of it without a VM.

## Quickstart

```ts
import { Limactl } from "jsr:@nullstyle/lima";

const lima = new Limactl();
await lima.requireVersion(); // limactl present and >= the supported floor

const vm = await lima.create("demo", { template: "ubuntu-24.04" }, {
  vmType: "vz",
});
try {
  await vm.waitReady();
  const uname = await vm.exec("uname -a", { check: true });
  console.log(uname.stdout.trim());
  await vm.copyInAsRoot("./service.token", "/etc/service/token", {
    mode: "0640",
  });
} finally {
  await vm.delete();
}
```

## What it is (and is not)

| Layer           | Export                          | What it does                                                                                                                                                |
| --------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client & handle | `.` (`Limactl`, `LimaInstance`) | Drives the `limactl` CLI: lifecycle, guest exec, copy in/out, snapshots, disks, readiness, typed `list --json` status.                                      |
| Template config | `./config`                      | Typed `LimaConfig` → deterministic YAML (`renderLimaYaml`). Byte-stable output you can commit and drift-test. Render-only — this package never parses YAML. |
| Subprocess seam | `./runner`                      | The injectable `CommandRunner` everything flows through.                                                                                                    |
| Test kit        | `./testing`                     | `FakeLimactl`: a recording, stateful in-memory limactl. Your tests assert exact argv with no VM and no `limactl` binary.                                    |

It is **not** an installer (bring your own `brew install lima`), not a YAML
parser, and not an opinion about your VM's contents — provisioning is your
script, delivered through `exec`/`copyInAsRoot`.

Everything shells out through one injectable seam, so any code built on this
package is testable with `FakeLimactl`:

```ts
import { Limactl } from "jsr:@nullstyle/lima";
import { FakeLimactl } from "jsr:@nullstyle/lima/testing";

const fake = new FakeLimactl();
const lima = new Limactl({ runner: fake });
await lima.create("demo", { template: "ubuntu-24.04" });
console.log(fake.commandLines());
// ["limactl start --name=demo --tty=false template:ubuntu-24.04"]
```

## Compatibility

Targets `limactl` >= 1.0.0 (`LIMA_COMPAT.minimum`). The real-VM smoke
(`deno task smoke`, macOS with lima installed) is the release gate; unit tests
run anywhere Deno runs.

## License

Apache-2.0
