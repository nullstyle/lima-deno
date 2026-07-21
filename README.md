# @nullstyle/lima

> **Status: 0.2.0.** Pre-1.0 — breaking changes ride a minor bump.

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
| Image building  | `./image`                       | Bake provisioned VMs into reusable images: `buildImage`, `captureImage`, digest pinning, cross-arch builds, an optional local `ImageStore` catalog.         |
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

## Building custom images

`./image` turns "boot a VM and run your setup scripts every time" into "bake
once, boot pre-provisioned":

```ts
import { buildImage, configFromImage, Limactl } from "jsr:@nullstyle/lima";

const lima = new Limactl();
const image = await buildImage(lima, {
  base: { template: "ubuntu-24.04" },
  outputPath: "./dev-base.qcow2",
  steps: [
    { run: "apt-get update && apt-get install -y build-essential", sudo: true },
    { copyIn: "./motd", to: "/etc/motd", mode: "0644" },
  ],
});
// image.digest is a sha256: pin Lima verifies at first boot.

const vm = await lima.create("dev1", {
  config: configFromImage(image, { disk: "20GiB", mounts: [] }),
});
await vm.waitReady(); // build-essential is already there
```

`buildImage` boots an ephemeral `--plain` builder VM, runs your steps, runs a
graded seal script (host keys, machine-id, authorized_keys — see
`DEFAULT_SEAL_SCRIPT`), captures the disk, and cleans up. `captureImage` is the
standalone primitive for baking any stopped instance. Cross-arch builds
(`arch: "x86_64"` on Apple Silicon) run under `vmType: "qemu"` TCG emulation.
The optional `ImageStore` catalogs built images in a directory with a
deterministic manifest and resolves them back to pinned `images:` entries.

Host requirements: building qcow2 output needs `qemu-img` (`brew install qemu`);
raw capture from vz instances needs nothing installed. Consumers of a built
image never need qemu — Lima reads (zlib-compressed) qcow2 natively. All of it
is testable without a VM: inject `FakeLimactl` and
`@nullstyle/qemu-img/testing`'s `FakeQemuImg`.

## Compatibility

Targets `limactl` >= 2.1.0 (`LIMA_COMPAT.minimum`) — the create path emits the
opaque `template:NAME` locator and repeatable `--set` (limactl >= 2.0) and
`--nested-virt` (>= 2.1). `requireVersion()` reports a clear error on older
installs. Image capture understands the Lima 2.x single-`disk` on-disk layout
(1.x basedisk/diffdisk layouts and Apple ASIF disks are detected and refused).
The real-VM smokes (`deno task smoke`, `deno task smoke:image`; macOS with lima
installed) are the release gate; unit tests run anywhere Deno runs.

Runtime dependencies (both first introduced in 0.2.0): `@std/crypto` (streaming
digests) and `@nullstyle/qemu-img` (the qemu-img driver, whose runner seam is
structurally identical to this package's).

## License

Apache-2.0
