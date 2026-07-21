import { assertEquals } from "@std/assert";
import { renderLimaYaml } from "../../src/config/render.ts";
import type { LimaConfig } from "../../src/config/types.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

/** The studiobox-host template, expressed through the typed config. */
const STUDIOBOX_SHAPE: LimaConfig = {
  base: "template://ubuntu-24.04",
  vmType: "vz",
  nestedVirtualization: true,
  rosetta: { enabled: false },
  cpus: 4,
  memory: "6GiB",
  disk: "40GiB",
  mounts: [],
  containerd: { system: false, user: false },
  portForwards: [
    { guestPort: 40000, hostIP: "127.0.0.1", hostPort: 40000 },
    { guestPort: 40001, hostIP: "127.0.0.1", hostPort: 40001 },
    {
      guestPortRange: [40100, 40199],
      hostIP: "127.0.0.1",
      hostPortRange: [40100, 40199],
    },
  ],
};

Deno.test("reproduces the studiobox template's functional bytes", () => {
  assertEquals(
    renderLimaYaml(STUDIOBOX_SHAPE),
    `base: template://ubuntu-24.04
vmType: vz
nestedVirtualization: true
rosetta:
  enabled: false
cpus: 4
memory: "6GiB"
disk: "40GiB"
mounts: []
containerd:
  system: false
  user: false
portForwards:
  - guestPort: 40000
    hostIP: "127.0.0.1"
    hostPort: 40000
  - guestPort: 40001
    hostIP: "127.0.0.1"
    hostPort: 40001
  - guestPortRange: [40100, 40199]
    hostIP: "127.0.0.1"
    hostPortRange: [40100, 40199]
`,
  );
});

Deno.test("rendering is deterministic", () => {
  assertEquals(
    renderLimaYaml(STUDIOBOX_SHAPE),
    renderLimaYaml(STUDIOBOX_SHAPE),
  );
});

Deno.test("kitchen-sink golden fixture is byte-stable", async () => {
  const expected = await Deno.readTextFile(
    new URL("kitchen-sink.yaml", FIXTURES),
  );
  assertEquals(renderLimaYaml(KITCHEN_SINK, KITCHEN_SINK_OPTIONS), expected);
});

Deno.test("header and per-key comments, including the empty-string separator", () => {
  const yaml = renderLimaYaml(
    { base: "template://ubuntu-24.04", vmType: "vz", cpus: 2 },
    {
      header: "Generated file.\n\nDo not edit.",
      comments: { vmType: "The VM block.", cpus: "" },
    },
  );
  assertEquals(
    yaml,
    `# Generated file.
#
# Do not edit.

base: template://ubuntu-24.04

# The VM block.
vmType: vz

cpus: 2
`,
  );
});

Deno.test("per-entry comments render above their list entry", () => {
  const yaml = renderLimaYaml({
    portForwards: [
      { guestPort: 8080, hostPort: 8080, comment: "The app port." },
    ],
  });
  assertEquals(
    yaml,
    `portForwards:
  # The app port.
  - guestPort: 8080
    hostPort: 8080
`,
  );
});

Deno.test("provision scripts render as literal blocks with inner blank lines", () => {
  const yaml = renderLimaYaml({
    provision: [{
      mode: "system",
      script: "#!/bin/bash\napt-get update\n\necho done\n",
    }],
  });
  assertEquals(
    yaml,
    `provision:
  - mode: system
    script: |
      #!/bin/bash
      apt-get update

      echo done
`,
  );
});

Deno.test("scalar quoting: plain vs quoted vs reserved words", () => {
  const yaml = renderLimaYaml({
    vmType: "vz",
    memory: "6GiB",
    mountType: "9p" as "virtiofs", // leading digit → quoted
    env: { PLAIN: "value", SPACED: "two words", RESERVED: "on" },
  });
  assertEquals(
    yaml,
    `vmType: vz
memory: "6GiB"
mountType: "9p"
env:
  PLAIN: value
  SPACED: "two words"
  RESERVED: "on"
`,
  );
});

Deno.test("base list form and raw block append", () => {
  const yaml = renderLimaYaml({
    base: ["template://ubuntu-24.04", "./extra.yaml"],
    vmType: "qemu",
    raw: "networks:\n  - lima: shared\n",
  });
  assertEquals(
    yaml,
    `base:
  - template://ubuntu-24.04
  - "./extra.yaml"
vmType: qemu
networks:
  - lima: shared
`,
  );
});

Deno.test("mounts: [] is distinct from unset", () => {
  assertEquals(renderLimaYaml({ mounts: [] }), "mounts: []\n");
  assertEquals(renderLimaYaml({}), "\n");
});

/** Exercises every typed key; pinned byte-for-byte by the committed fixture. */
export const KITCHEN_SINK: LimaConfig = {
  minimumLimaVersion: "1.0.0",
  base: "template://ubuntu-24.04",
  vmType: "qemu",
  nestedVirtualization: false,
  rosetta: { enabled: true, binfmt: true },
  os: "Linux",
  arch: "x86_64",
  images: [
    {
      location: "https://example.com/img.qcow2",
      arch: "x86_64",
      digest: "sha256:abc123",
      comment: "Primary image.",
    },
  ],
  cpus: 8,
  memory: "16GiB",
  disk: "100GiB",
  additionalDisks: [{ name: "scratch", format: true, fsType: "ext4" }],
  mounts: [
    { location: "~", writable: false },
    { location: "/tmp/shared", mountPoint: "/mnt/shared", writable: true },
  ],
  mountType: "virtiofs",
  ssh: { localPort: 2222, loadDotSSHPubKeys: true, forwardAgent: false },
  containerd: { system: false, user: true },
  provision: [
    { mode: "system", script: "#!/bin/bash\napt-get install -y curl" },
    { mode: "user", script: "echo user-setup", comment: "Runs unprivileged." },
  ],
  probes: [
    {
      mode: "readiness",
      description: "curl is installed",
      script: "#!/bin/bash\ncommand -v curl",
      hint: "provisioning has not finished",
    },
  ],
  portForwards: [
    {
      guestIP: "0.0.0.0",
      guestPort: 80,
      hostIP: "127.0.0.1",
      hostPort: 8080,
      proto: "tcp",
    },
    {
      guestSocket: "/run/svc.sock",
      hostSocket: "/tmp/svc.sock",
      reverse: false,
    },
    { guestPortRange: [9000, 9010], hostPortRange: [9000, 9010], ignore: true },
  ],
  env: { EDITOR: "vim", SHELL_STYLE: "strict mode" },
  raw: "dns:\n  - 1.1.1.1\n",
};

export const KITCHEN_SINK_OPTIONS = {
  header: "Kitchen-sink fixture.",
  comments: { mounts: "Host mounts.", portForwards: "" },
} as const;
