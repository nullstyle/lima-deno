/**
 * The declarative image builder: boot an ephemeral builder VM, provision it,
 * seal it, capture its disk, clean up.
 *
 * @module
 */

import { QemuImg } from "@nullstyle/qemu-img";
import type { CreateOptions, CreateSource, Limactl } from "../limactl.ts";
import type { LimaInstance, WaitReadyOptions } from "../instance.ts";
import type { CommandRunner } from "../runner.ts";
import type { CallOptions } from "../options.ts";
import { ImageBuildError } from "./errors.ts";
import type { QemuImgLike } from "./qemu_img_like.ts";
import type {
  BuiltImage,
  ImageBuildPhase,
  ImageEvent,
  ImageFormat,
} from "./types.ts";
import { captureImage } from "./capture.ts";
import { hostArch, type LimaArch } from "./spec.ts";

/**
 * One build-time provisioning step, discriminated by key:
 * - `{run}` — a bash script in the guest (`exec`, `check: true`);
 * - `{copyIn, to}` — a host→guest copy; with `mode`/`owner`/`group` it is
 *   delivered root-owned via `copyInAsRoot` (single files only), otherwise
 *   via plain `copyIn`;
 * - `{fn}` — an arbitrary hook receiving the builder instance.
 */
export type BuildStep =
  | {
    /** Bash script to run in the guest. */
    readonly run: string;
    /** Run privileged (`sudo -E`). */
    readonly sudo?: boolean;
    /** Run as this user (implies sudo). */
    readonly user?: string;
    /** Guest working directory. */
    readonly workdir?: string;
    /** Environment exported to the script. */
    readonly env?: Readonly<Record<string, string>>;
    /** Shown in progress events. */
    readonly comment?: string;
  }
  | {
    /** Local path to copy into the guest. */
    readonly copyIn: string;
    /** Guest destination path. */
    readonly to: string;
    /** Copy a directory recursively (plain copy only). */
    readonly recursive?: boolean;
    /** Destination mode — presence routes through `copyInAsRoot`. */
    readonly mode?: string;
    /** Destination owner — presence routes through `copyInAsRoot`. */
    readonly owner?: string;
    /** Destination group — presence routes through `copyInAsRoot`. */
    readonly group?: string;
    /** Shown in progress events. */
    readonly comment?: string;
  }
  | {
    /** Arbitrary hook: run anything against the builder instance. */
    readonly fn: (vm: LimaInstance) => void | Promise<void>;
    /** Shown in progress events. */
    readonly comment?: string;
  };

/** What to build. */
export interface ImageBuildSpec {
  /** The builder VM's config source (template, url, file, yaml, or typed config). */
  readonly base: CreateSource;
  /** Host path for the produced image. */
  readonly outputPath: string;
  /** Output format. @default "qcow2" */
  readonly format?: ImageFormat;
  /** Compress qcow2 output (zlib `-c`). @default true */
  readonly compress?: boolean;
  /**
   * Guest architecture (`--arch`). A foreign arch is a cross-build: it
   * requires `vmType: "qemu"` (TCG emulation — boots take many minutes) and
   * QEMU installed; the preflight enforces both.
   */
  readonly arch?: LimaArch;
  /** Builder VM name. @default "lima-img-build-" + random suffix */
  readonly name?: string;
  /**
   * Builder VM shape (`limactl start` flags), merged over the builder
   * defaults `{plain: true, cpus: 2, memoryGiB: 2, diskGiB: 10}`. The
   * defaults keep host machinery out of the image (`--plain` still runs
   * cloud-init, ssh, and provisioning) and keep the image's virtual size —
   * the floor every derived VM must meet — small.
   */
  readonly create?: CreateOptions;
  /** Provision steps, run in order after the VM is ready. */
  readonly steps?: readonly BuildStep[];
  /**
   * Generalize the image before capture. `true` (the default) runs
   * {@linkcode DEFAULT_SEAL_SCRIPT}; `{script}` runs a custom seal;
   * `false` skips sealing (an unsealed Lima 2.x image still boots as a new
   * instance — sealing matters when the image is distributed).
   */
  readonly seal?: boolean | { readonly script: string };
}

/** How to run the build. */
export interface ImageBuildOptions extends CallOptions {
  /**
   * Readiness options for the builder VM. Cross-arch builds default
   * `timeoutMs` to 30 minutes (TCG-emulated boots are slow); same-arch
   * builds use `waitReady`'s own default.
   */
  readonly waitReady?: WaitReadyOptions;
  /**
   * The qemu-img client to use (`@nullstyle/qemu-img`'s `QemuImg` fits
   * as-is); inject one sharing your fake runner in tests.
   * @default new QemuImg()
   */
  readonly qemuImg?: QemuImgLike;
  /** Runner for the `cp` clone in raw-from-raw capture. */
  readonly runner?: CommandRunner;
  /** Keep the builder VM when the build fails, for debugging. @default false */
  readonly keepOnFailure?: boolean;
  /** Progress callback (the library never logs). */
  readonly onEvent?: (event: ImageEvent) => void;
}

/**
 * The default seal, run as root in the builder guest just before capture.
 *
 * Grading: `MUST(dist)` lines matter when the image leaves this machine
 * (host keys, machine identity, injected credentials, stored entropy);
 * `SHOULD` lines are hygiene and size. Booting as a new instance needs none
 * of this — Lima issues a fresh cloud-init instance-id on every start, so
 * users, ssh authorized keys, hostname, and network config are re-applied
 * per boot regardless.
 *
 * Exported so it is inspectable; replace it via `seal: {script}`.
 */
export const DEFAULT_SEAL_SCRIPT: string =
  `# MUST(dist): no ssh host private keys in a distributable image
# (cloud-init regenerates them on the next boot).
rm -f /etc/ssh/ssh_host_*key*

# MUST(dist): unique machine identity per clone — systemd-networkd derives
# its DHCP DUID from machine-id, so clones would collide on one network.
if command -v cloud-init >/dev/null 2>&1; then
  cloud-init clean --logs --seed --machine-id 2>/dev/null || {
    cloud-init clean --logs --seed || true
    truncate -s 0 /etc/machine-id
  }
else
  truncate -s 0 /etc/machine-id
fi
rm -f /var/lib/dbus/machine-id
ln -s /etc/machine-id /var/lib/dbus/machine-id 2>/dev/null || true

# MUST(dist): the builder host's ssh pubkey and stored entropy must not ship
# (the next host's key is re-injected by cloud-init on boot anyway).
find /home -maxdepth 3 -name authorized_keys -delete 2>/dev/null || true
rm -f /root/.ssh/authorized_keys /var/lib/systemd/random-seed

# SHOULD: package caches and logs (size).
apt-get clean 2>/dev/null || true
rm -rf /var/lib/apt/lists/* 2>/dev/null || true
{ command -v dnf >/dev/null 2>&1 && dnf clean all >/dev/null 2>&1; } || true
journalctl --rotate 2>/dev/null || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
find /var/log -type f \\( -name '*.gz' -o -name '*.1' -o -name '*.old' \\) -delete 2>/dev/null || true
truncate -s 0 /var/log/wtmp /var/log/btmp /var/log/lastlog 2>/dev/null || true

# SHOULD: transient state and shell history (hygiene).
rm -rf /tmp/* /var/tmp/* 2>/dev/null || true
rm -f /root/.bash_history
find /home -maxdepth 2 -name .bash_history -delete 2>/dev/null || true

# SHOULD: return freed blocks so the captured image is small (and compresses
# well). Best effort — discard support varies by vmType.
fstrim -av >/dev/null 2>&1 || true
sync`;

/**
 * Build a custom image: create an ephemeral builder VM from `spec.base`,
 * wait for readiness, run the provision steps, seal, capture the disk to
 * `spec.outputPath`, and delete the builder. On failure the builder is
 * deleted too (unless `keepOnFailure`) and the escaping error is wrapped in
 * {@linkcode ImageBuildError} with the failing phase.
 */
export async function buildImage(
  lima: Limactl,
  spec: ImageBuildSpec,
  options: ImageBuildOptions = {},
): Promise<BuiltImage> {
  const call: CallOptions = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined
      ? {}
      : { timeoutMs: options.timeoutMs }),
  };
  const format = spec.format ?? "qcow2";
  const qemuImg = options.qemuImg ?? new QemuImg();
  const emit = options.onEvent ?? (() => {});
  const name = spec.name ?? `lima-img-build-${crypto.randomUUID().slice(0, 8)}`;
  const crossArch = spec.arch !== undefined && spec.arch !== hostArch();

  let phase: ImageBuildPhase = "preflight";
  let stepIndex: number | undefined;
  let vm: LimaInstance | undefined;

  try {
    emit({ type: "phase", phase, instance: name });
    if (crossArch) {
      const vmType = spec.create?.vmType ??
        ("config" in spec.base ? spec.base.config.vmType : undefined);
      if (vmType !== "qemu") {
        throw new ImageBuildError(phase, name, {
          cause: new Error(
            `cross-arch builds (${spec.arch} on ${hostArch()}) need ` +
              'vmType: "qemu" + QEMU installed (brew install qemu)',
          ),
        });
      }
      await qemuImg.ensureAvailable(call);
    }
    if (format === "qcow2") {
      // Fail on a missing qemu-img BEFORE minutes of VM boot.
      await qemuImg.ensureAvailable(call);
    }

    phase = "create";
    emit({ type: "phase", phase, instance: name });
    vm = await lima.create(name, spec.base, {
      plain: true,
      cpus: 2,
      memoryGiB: 2,
      diskGiB: 10,
      ...(spec.arch === undefined ? {} : { arch: spec.arch }),
      ...spec.create,
      ...call,
    });

    phase = "wait-ready";
    emit({ type: "phase", phase, instance: name });
    await vm.waitReady({
      ...(crossArch ? { timeoutMs: 1_800_000 } : {}),
      ...options.waitReady,
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });

    phase = "provision";
    const steps = spec.steps ?? [];
    for (let index = 0; index < steps.length; index++) {
      stepIndex = index;
      const step = steps[index];
      emit({
        type: "step",
        index,
        count: steps.length,
        ...(step.comment === undefined ? {} : { comment: step.comment }),
      });
      await runStep(vm, step, call);
    }
    stepIndex = undefined;

    if (spec.seal !== false) {
      phase = "seal";
      emit({ type: "phase", phase, instance: name });
      const script = typeof spec.seal === "object"
        ? spec.seal.script
        : DEFAULT_SEAL_SCRIPT;
      await vm.exec(script, { check: true, sudo: true, ...call });
    }

    const image = await captureImage(vm, {
      outputPath: spec.outputPath,
      format,
      ...(spec.compress === undefined ? {} : { compress: spec.compress }),
      qemuImg,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...call,
      onEvent: (event) => {
        // Mirror capture's phases so a failure in there wraps accurately.
        if (event.type === "phase") phase = event.phase;
        emit(event);
      },
    });

    phase = "cleanup";
    emit({ type: "phase", phase, instance: name });
    await vm.delete(call);
    return image;
  } catch (error) {
    const kept = options.keepOnFailure === true;
    if (vm !== undefined && !kept && phase !== "cleanup") {
      // Best effort — the original error wins.
      try {
        await vm.delete(call);
      } catch {
        // ignored
      }
    }
    if (error instanceof ImageBuildError) throw error;
    throw new ImageBuildError(phase, name, {
      ...(stepIndex === undefined ? {} : { stepIndex }),
      kept,
      cause: error,
    });
  }
}

async function runStep(
  vm: LimaInstance,
  step: BuildStep,
  call: CallOptions,
): Promise<void> {
  if ("run" in step) {
    await vm.exec(step.run, {
      check: true,
      ...(step.sudo === undefined ? {} : { sudo: step.sudo }),
      ...(step.user === undefined ? {} : { user: step.user }),
      ...(step.workdir === undefined ? {} : { workdir: step.workdir }),
      ...(step.env === undefined ? {} : { env: step.env }),
      ...call,
    });
    return;
  }
  if ("copyIn" in step) {
    if (
      step.mode !== undefined || step.owner !== undefined ||
      step.group !== undefined
    ) {
      await vm.copyInAsRoot(step.copyIn, step.to, {
        ...(step.mode === undefined ? {} : { mode: step.mode }),
        ...(step.owner === undefined ? {} : { owner: step.owner }),
        ...(step.group === undefined ? {} : { group: step.group }),
        ...call,
      });
      return;
    }
    await vm.copyIn(step.copyIn, step.to, {
      ...(step.recursive === undefined ? {} : { recursive: step.recursive }),
      ...call,
    });
    return;
  }
  await step.fn(vm);
}
