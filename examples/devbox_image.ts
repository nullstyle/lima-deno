/**
 * Example: derive a custom Lima image, then keep it updated over time.
 *
 * The story is the common one — a team dev image that is expensive to build
 * from scratch and needs a cheap periodic refresh:
 *
 *     deno run -A examples/devbox_image.ts build   # next generation
 *     deno run -A examples/devbox_image.ts list    # what's in the store
 *     deno run -A examples/devbox_image.ts run     # boot a VM from the newest
 *     deno run -A examples/devbox_image.ts rebase  # rebuild from upstream
 *
 * `build` derives: the newest stored generation becomes the next builder's own
 * base image, so gen 2+ skips the expensive install gen 1 already baked in.
 * Every generation is sealed, digest-pinned, and catalogued, and older ones
 * stay bootable — rollback is `run <name>`.
 *
 * Requires limactl, plus qemu-img for qcow2 output (`brew install qemu`).
 * A real consumer imports from JSR rather than these relative paths:
 *
 *     import { buildImage, ImageStore, Limactl } from "jsr:@nullstyle/lima";
 *
 * @module
 */

import {
  buildImage,
  type BuildStep,
  configFromImage,
  formatImageEvent,
  ImageStore,
  Limactl,
  type StoredImage,
  withInstance,
} from "../mod.ts";

/** Override to keep experiments out of your real store. */
const STORE_DIR = Deno.env.get("DEVBOX_STORE_DIR") ??
  `${Deno.env.get("HOME") ?? "."}/.local/share/devbox-images`;

/**
 * The upstream base `rebase` starts from. A rolling tag: each rebase picks up
 * whatever Ubuntu ships today. Pin an explicit `images:` entry with a digest
 * instead if you need byte-reproducible rebuilds.
 */
const UPSTREAM = "ubuntu-24.04";

/** Names are `devbox-<n>`; ordering comes from the store, not from the name. */
const PREFIX = "devbox-";

/**
 * Run once, from upstream. The expensive part — the whole point of baking an
 * image is that derived generations never pay for it again.
 */
const INSTALL_STEPS: readonly BuildStep[] = [
  {
    comment: "base packages",
    sudo: true,
    run: `
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends build-essential git jq ripgrep
    `,
  },
];

/**
 * Run on every generation, including the first. Keep these cheap and
 * idempotent — they are the "update over time" half of the workflow.
 */
const REFRESH_STEPS: readonly BuildStep[] = [
  {
    comment: "security updates",
    sudo: true,
    run: `
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get -y upgrade
    `,
  },
  {
    comment: "stamp the generation",
    sudo: true,
    // Worth baking: this is how a running VM can say which image it came
    // from, which `limactl list` cannot.
    run: `date -u +'built %Y-%m-%dT%H:%M:%SZ' > /etc/devbox-generation`,
  },
];

const store = new ImageStore({ dir: STORE_DIR });
const lima = new Limactl();

/** Print progress; the library never logs, so the sink is always yours. */
function report(event: Parameters<typeof formatImageEvent>[0]): void {
  const line = formatImageEvent(event);
  if (line !== undefined) console.log(`  · ${line}`);
}

/**
 * Build the next generation: a full install from upstream when the store is
 * empty or `fromUpstream` is set, otherwise a derivation from the newest.
 */
async function build(fromUpstream: boolean): Promise<StoredImage> {
  const previous = fromUpstream ? undefined : await store.latest(PREFIX);
  const name = `${PREFIX}${(previous ? count(previous) : 0) + 1}`;

  // Stage outside the store: a crash after capture would otherwise orphan a
  // multi-GB file inside it, invisible to `list()`. Same filesystem, so the
  // `move: true` below stays a rename rather than a copy.
  const staging = `${STORE_DIR}/.staging`;
  await Deno.mkdir(staging, { recursive: true });
  const outputPath = `${staging}/${name}.qcow2`;

  const steps = previous === undefined
    ? [...INSTALL_STEPS, ...REFRESH_STEPS]
    : REFRESH_STEPS;
  console.log(
    previous === undefined
      ? `▸ ${name}: full build from ${UPSTREAM}`
      : `▸ ${name}: derived from ${previous.name} (${steps.length} steps)`,
  );

  try {
    const image = await buildImage(lima, {
      // The whole derivation, right here: the previous generation IS the
      // base. buildImage pins it by digest and sizes the builder's disk to
      // it — a derived VM can never be smaller than the image it boots.
      base: previous === undefined
        ? { template: UPSTREAM }
        : { image: previous },
      outputPath,
      steps,
      // Named so a Ctrl-C leaves something you can find and delete.
      name: `${name}-builder`,
    }, { onEvent: report });

    const stored = await store.put(name, image, { move: true });
    console.log(`✓ ${stored.name}  ${stored.digest.slice(0, 19)}…`);
    return stored;
  } finally {
    await Deno.remove(outputPath).catch(() => {});
  }
}

/** Boot a throwaway VM from a stored generation and show what's baked in. */
async function run(requested: string | undefined): Promise<void> {
  const image = requested === undefined
    ? await store.latest(PREFIX)
    : await store.get(requested);
  if (image === undefined) {
    console.error(
      requested === undefined
        ? "no generations yet — run `build` first"
        : `no such generation: ${requested}`,
    );
    Deno.exit(1);
  }

  console.log(`▸ booting a throwaway VM from ${image.name}`);
  // configFromImage makes the image the SOLE images: entry, so a digest
  // mismatch fails the create loudly instead of silently falling through.
  // No `disk:` — Lima's default already exceeds anything built here, and
  // computing one from the image would only shrink the VM.
  const stamp = await withInstance(
    lima,
    `devbox-try-${Date.now().toString(36)}`,
    { config: configFromImage(image, { cpus: 4, memory: "8GiB" }) },
    async (vm) =>
      (await vm.exec("cat /etc/devbox-generation", { check: true })).stdout,
    { keepOnSuccess: true },
  );
  console.log(`✓ ${image.name} is live — ${stamp.trim()}`);
  console.log(
    "  · shell in with `limactl shell <name>`; it is yours to delete",
  );
}

async function list(): Promise<void> {
  const all = await store.list({ prefix: PREFIX, order: "createdAt" });
  if (all.length === 0) {
    console.log("no generations yet — run `build`");
    return;
  }
  for (const image of all) console.log(`${image.name}\t${image.createdAt}`);
}

/** Generation number, from the name we assigned it. */
function count(image: StoredImage): number {
  return Number(image.name.slice(PREFIX.length)) || 0;
}

if (import.meta.main) {
  const [command, argument] = Deno.args;
  await lima.requireVersion();
  switch (command) {
    case "build":
      await build(false);
      break;
    case "rebase":
      // Derived generations stack forever: an apt upgrade in gen 9 cannot
      // un-install what gen 2 added, and the image only grows. Rebuild from
      // upstream periodically to collapse the accumulated layers.
      await build(true);
      break;
    case "run":
      await run(argument);
      break;
    case "list":
      await list();
      break;
    default:
      // No implicit default: every other command here boots a VM.
      console.error("usage: devbox_image.ts [build|rebase|run [name]|list]");
      Deno.exit(2);
  }
}
