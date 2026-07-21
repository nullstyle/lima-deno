/**
 * {@linkcode FakeLimactl} — a recording, stateful fake of the `limactl` CLI
 * implementing the {@linkcode import("../src/runner.ts").CommandRunner} seam.
 *
 * It models a coherent in-memory Lima host (instances, their status, guest
 * files, disks, snapshots) and dispatches on the exact argv the library
 * emits, so tests assert both behavior AND the precise `limactl` command
 * sequence — with no VM and no `limactl` binary.
 *
 * Extension points for downstream test kits (both `protected`, both stable):
 * {@linkcode FakeLimactl.onGuestScript} interprets guest scripts (the
 * strict/sudo wrapping is already stripped), {@linkcode FakeLimactl.onCommand}
 * handles non-limactl binaries. Return `undefined` from either to fall
 * through to the built-in semantics.
 *
 * @module
 */

import type {
  CommandResult,
  CommandRunner,
  RunOptions,
} from "../src/runner.ts";

/** One recorded invocation. */
export interface RecordedCall {
  /** The binary invoked. */
  readonly bin: string;
  /** The argv it was invoked with. */
  readonly args: readonly string[];
  /** Bytes piped to stdin, when any. */
  readonly stdin?: string;
}

/** A decoded `limactl shell` invocation handed to {@linkcode FakeLimactl.onGuestScript}. */
export interface GuestScriptCall {
  /** The instance the script targets. */
  readonly instance: string;
  /** The inner script — strict (`set -euo pipefail; `) and sudo wrapping stripped. */
  readonly script: string;
  /** Whether the script was sudo-wrapped. */
  readonly sudo: boolean;
  /** The `sudo -u` user, when present. */
  readonly user?: string;
  /** The `--workdir` value, when present. */
  readonly workdir?: string;
  /** The raw recorded call. */
  readonly raw: RecordedCall;
}

/** Mutable per-instance fake state. */
export interface FakeInstanceState {
  /** Reported status (e.g. `"Running"`, `"Stopped"`, `"Broken"`). */
  status: string;
  /** Reported vmType. @default "vz" */
  vmType?: string;
  /** Reported architecture. @default "aarch64" */
  arch?: string;
  /** Reported vCPU count. */
  cpus?: number;
  /** Reported memory in bytes. */
  memory?: number;
  /** Reported disk size in bytes. */
  disk?: number;
  /** Reported instance directory. */
  dir?: string;
  /** Reported host-side ssh port. */
  sshLocalPort?: number;
  /** Broken-state diagnostics. */
  errors?: string[];
  /** Deletion protection. */
  protected?: boolean;
  /** YAML captured from a stdin (`start … -`) create. */
  configYaml?: string;
  /** Snapshot tags. */
  snapshots: Set<string>;
}

/** Mutable per-disk fake state. */
export interface FakeDiskState {
  /** Disk size (Lima size grammar). */
  size: string;
  /** Disk image format. */
  format?: string;
  /** The instance using the disk, when attached. */
  instance?: string;
}

/** Success-result helper for stubbing and hook implementations. */
export function ok(stdout = ""): CommandResult {
  return { success: true, code: 0, stdout, stderr: "" };
}

/** Failure-result helper for stubbing and hook implementations. */
export function failed(code = 1, stderr = ""): CommandResult {
  return { success: false, code, stdout: "", stderr };
}

const SUDO_WRAP = /^(\S+) -E(?: -u (\S+))? bash -lc '([\s\S]*)'$/;
const STRICT_PREFIX = "set -euo pipefail; ";
const TEST_F = /^test -f '?([^']+)'?$/;
const INSTALL =
  /^install -m (\S+)(?: -o (\S+))?(?: -g (\S+))? '([^']+)' '([^']+)' && rm -f '([^']+)'$/;

/** A scripted response override, checked before the state machine. */
interface Stub {
  readonly match: (call: RecordedCall) => boolean;
  readonly result: CommandResult;
  used: boolean;
}

/** The recording fake. See the module doc. */
export class FakeLimactl implements CommandRunner {
  /** Every recorded invocation, in order. */
  readonly calls: RecordedCall[] = [];
  /** The fake host's instances. */
  readonly instances: Map<string, FakeInstanceState> = new Map();
  /** Guest filesystem paths per instance. */
  readonly guestFiles: Map<string, Set<string>> = new Map();
  /** The fake host's disks. */
  readonly disks: Map<string, FakeDiskState> = new Map();
  /** `limactl --version` stdout. */
  versionOutput = "limactl version 1.0.6";

  readonly #stubs: Stub[] = [];

  /** Add (or update) an instance; running by default. */
  setInstance(name: string, state: Partial<FakeInstanceState> = {}): void {
    const existing = this.instances.get(name);
    this.instances.set(name, {
      status: "Running",
      snapshots: new Set(),
      ...existing,
      ...state,
      ...(state.snapshots === undefined && existing === undefined
        ? { snapshots: new Set<string>() }
        : {}),
    });
  }

  /** The guest file set for an instance (created on demand). */
  guestFilesFor(name: string): Set<string> {
    let files = this.guestFiles.get(name);
    if (files === undefined) {
      files = new Set();
      this.guestFiles.set(name, files);
    }
    return files;
  }

  /** Every call flattened to `"bin arg arg…"` — the assertion convenience. */
  commandLines(): string[] {
    return this.calls.map((call) => [call.bin, ...call.args].join(" "));
  }

  /**
   * Scripted override checked before the state machine — failure injection
   * without subclassing. Each stub fires once.
   */
  stub(match: (call: RecordedCall) => boolean, result: CommandResult): void {
    this.#stubs.push({ match, result, used: false });
  }

  /** Record the call, apply stubs, then dispatch to the state machine. */
  run(
    bin: string,
    args: readonly string[],
    options: RunOptions = {},
  ): Promise<CommandResult> {
    const call: RecordedCall = {
      bin,
      args: [...args],
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    };
    this.calls.push(call);
    for (const stub of this.#stubs) {
      if (!stub.used && stub.match(call)) {
        stub.used = true;
        return Promise.resolve(stub.result);
      }
    }
    if (bin.endsWith("limactl")) {
      return Promise.resolve(this.limactl(call));
    }
    return Promise.resolve(this.onCommand(call) ?? ok());
  }

  /**
   * EXTENSION HOOK: interpret a guest script (already unwrapped). Return
   * `undefined` to fall through to the built-ins (`test -f`, the
   * `install -m … && rm` staging completion).
   */
  protected onGuestScript(_call: GuestScriptCall): CommandResult | undefined {
    return undefined;
  }

  /**
   * EXTENSION HOOK: handle a non-limactl binary (`bash`, `git`, `tar`, …).
   * Return `undefined` for the default `ok("")`.
   */
  protected onCommand(_call: RecordedCall): CommandResult | undefined {
    return undefined;
  }

  /** The limactl argv state machine. Overridable as a last resort; prefer the hooks. */
  protected limactl(call: RecordedCall): CommandResult {
    const args = call.args;
    switch (args[0]) {
      case "--version":
        return ok(`${this.versionOutput}\n`);
      case "list":
        return this.#list(args);
      case "start":
        return this.#start(call);
      case "stop":
        return this.#simpleTransition(args, "Stopped");
      case "restart":
        return this.#simpleTransition(args, "Running");
      case "delete": {
        const name = lastPositional(args);
        if (!this.instances.has(name)) {
          return failed(1, `instance "${name}" does not exist`);
        }
        this.instances.delete(name);
        this.guestFiles.delete(name);
        return ok();
      }
      case "factory-reset": {
        const state = this.instances.get(lastPositional(args));
        if (state === undefined) {
          return failed(1, `instance "${lastPositional(args)}" does not exist`);
        }
        state.status = "Stopped";
        this.guestFiles.delete(lastPositional(args));
        return ok();
      }
      case "protect":
      case "unprotect": {
        const state = this.instances.get(lastPositional(args));
        if (state === undefined) {
          return failed(1, `instance "${lastPositional(args)}" does not exist`);
        }
        state.protected = args[0] === "protect";
        return ok();
      }
      case "snapshot":
        return this.#snapshot(args);
      case "disk":
        return this.#disk(args);
      case "cp":
        return this.#cp(args);
      case "shell":
        return this.#shell(call);
      default:
        return failed(1, `fake limactl: unhandled subcommand ${args[0]}`);
    }
  }

  #list(args: readonly string[]): CommandResult {
    if (args.includes("-q")) {
      return ok([...this.instances.keys()].map((name) => `${name}\n`).join(""));
    }
    if (args.includes("--json")) {
      const lines = [...this.instances.entries()].map(([name, state]) =>
        JSON.stringify({
          name,
          status: state.status,
          dir: state.dir ?? `/home/user/.lima/${name}`,
          vmType: state.vmType ?? "vz",
          arch: state.arch ?? "aarch64",
          cpus: state.cpus ?? 4,
          memory: state.memory ?? 4294967296,
          disk: state.disk ?? 107374182400,
          sshLocalPort: state.sshLocalPort ?? 60022,
          errors: state.errors ?? [],
          protected: state.protected ?? false,
        })
      );
      return ok(lines.map((line) => `${line}\n`).join(""));
    }
    if (args.includes("--format")) {
      return ok(
        [...this.instances.entries()]
          .map(([name, state]) => `${name}\t${state.status}\n`)
          .join(""),
      );
    }
    return failed(1, "fake limactl: unhandled list form");
  }

  #start(call: RecordedCall): CommandResult {
    const args = call.args;
    const nameFlag = args.find((arg) => arg.startsWith("--name="));
    if (nameFlag === undefined) {
      // `limactl start <name>` — boot an existing instance.
      const name = lastPositional(args);
      const state = this.instances.get(name);
      if (state === undefined) {
        return failed(1, `instance "${name}" does not exist`);
      }
      state.status = "Running";
      return ok();
    }
    // Create form: `limactl start --name=<n> [flags] --tty=false <source>`.
    const name = nameFlag.slice("--name=".length);
    if (this.instances.has(name)) {
      return failed(1, `instance "${name}" already exists`);
    }
    const vmTypeFlag = args.find((arg) => arg.startsWith("--vm-type="));
    this.setInstance(name, {
      status: "Running",
      ...(vmTypeFlag === undefined
        ? {}
        : { vmType: vmTypeFlag.slice("--vm-type=".length) }),
      ...(call.stdin === undefined ? {} : { configYaml: call.stdin }),
    });
    return ok();
  }

  #simpleTransition(args: readonly string[], status: string): CommandResult {
    const name = lastPositional(args);
    const state = this.instances.get(name);
    if (state === undefined) {
      return failed(1, `instance "${name}" does not exist`);
    }
    state.status = status;
    return ok();
  }

  #snapshot(args: readonly string[]): CommandResult {
    const [, op, name] = args;
    const state = name === undefined ? undefined : this.instances.get(name);
    if (state === undefined) {
      return failed(1, `instance "${name}" does not exist`);
    }
    const tagIndex = args.indexOf("--tag");
    const tag = tagIndex === -1 ? undefined : args[tagIndex + 1];
    switch (op) {
      case "create":
        if (tag === undefined) return failed(1, "missing --tag");
        state.snapshots.add(tag);
        return ok();
      case "apply":
        if (tag === undefined || !state.snapshots.has(tag)) {
          return failed(1, `snapshot ${tag} does not exist`);
        }
        return ok();
      case "delete":
        if (tag === undefined || !state.snapshots.delete(tag)) {
          return failed(1, `snapshot ${tag} does not exist`);
        }
        return ok();
      case "list":
        return ok(
          [...state.snapshots].map((entry) => `${entry}\n`).join(""),
        );
      default:
        return failed(1, `fake limactl: unhandled snapshot op ${op}`);
    }
  }

  #disk(args: readonly string[]): CommandResult {
    const [, op] = args;
    switch (op) {
      case "create": {
        const name = args[2];
        const sizeFlag = args.find((arg) => arg.startsWith("--size="));
        if (name === undefined || sizeFlag === undefined) {
          return failed(1, "fake limactl: disk create needs a name and --size");
        }
        const formatFlag = args.find((arg) => arg.startsWith("--format="));
        this.disks.set(name, {
          size: sizeFlag.slice("--size=".length),
          ...(formatFlag === undefined
            ? {}
            : { format: formatFlag.slice("--format=".length) }),
        });
        return ok();
      }
      case "ls": {
        const lines = [...this.disks.entries()].map(([name, state]) =>
          JSON.stringify({
            name,
            size: state.size,
            format: state.format ?? "raw",
            ...(state.instance === undefined
              ? {}
              : { instance: state.instance }),
          })
        );
        return ok(lines.map((line) => `${line}\n`).join(""));
      }
      case "delete": {
        const name = args[2];
        if (name === undefined || !this.disks.delete(name)) {
          return failed(1, `disk "${name}" does not exist`);
        }
        return ok();
      }
      case "resize": {
        const name = args[2];
        const sizeFlag = args.find((arg) => arg.startsWith("--size="));
        const disk = name === undefined ? undefined : this.disks.get(name);
        if (disk === undefined || sizeFlag === undefined) {
          return failed(1, `disk "${name}" does not exist`);
        }
        disk.size = sizeFlag.slice("--size=".length);
        return ok();
      }
      default:
        return failed(1, `fake limactl: unhandled disk op ${op}`);
    }
  }

  #cp(args: readonly string[]): CommandResult {
    const positional = args.slice(1).filter((arg) => arg !== "-r");
    const [src, dst] = positional;
    if (src === undefined || dst === undefined) {
      return failed(1, "fake limactl: cp needs src and dst");
    }
    const srcGuest = splitGuestPath(src);
    const dstGuest = splitGuestPath(dst);
    if (dstGuest !== undefined) {
      if (!this.instances.has(dstGuest.instance)) {
        return failed(1, `instance "${dstGuest.instance}" does not exist`);
      }
      this.guestFilesFor(dstGuest.instance).add(dstGuest.path);
      return ok();
    }
    if (srcGuest !== undefined) {
      const files = this.guestFiles.get(srcGuest.instance);
      if (files === undefined || !files.has(srcGuest.path)) {
        return failed(1, `${src}: no such file or directory`);
      }
      return ok();
    }
    return failed(1, "fake limactl: cp with no instance side");
  }

  #shell(call: RecordedCall): CommandResult {
    const args = call.args;
    let index = 1;
    let workdir: string | undefined;
    if (args[index] === "--workdir") {
      workdir = args[index + 1];
      index += 2;
    }
    const instance = args[index];
    if (instance === undefined || args[index + 1] !== "--") {
      return failed(1, "fake limactl: unhandled shell form");
    }
    const rest = args.slice(index + 2);
    if (!this.instances.has(instance)) {
      return failed(1, `instance "${instance}" does not exist`);
    }
    let script: string;
    let sudo = false;
    let user: string | undefined;
    if (rest[0] === "bash" && rest[1] === "-lc" && rest.length === 3) {
      let body = rest[2]!;
      const sudoMatch = SUDO_WRAP.exec(body);
      if (sudoMatch !== null) {
        sudo = true;
        user = sudoMatch[2];
        body = sudoMatch[3]!.replaceAll(`'\\''`, `'`);
      }
      script = body.startsWith(STRICT_PREFIX)
        ? body.slice(STRICT_PREFIX.length)
        : body;
    } else {
      script = rest.join(" ");
    }
    const guestCall: GuestScriptCall = {
      instance,
      script,
      sudo,
      ...(user === undefined ? {} : { user }),
      ...(workdir === undefined ? {} : { workdir }),
      raw: call,
    };
    return this.onGuestScript(guestCall) ?? this.#interpretGuest(guestCall);
  }

  #interpretGuest(call: GuestScriptCall): CommandResult {
    const files = this.guestFilesFor(call.instance);
    const testMatch = TEST_F.exec(call.script);
    if (testMatch !== null) {
      return files.has(testMatch[1]!) ? ok() : failed(1);
    }
    const installMatch = INSTALL.exec(call.script);
    if (installMatch !== null) {
      const [, , , , staged, dest, removed] = installMatch;
      if (!files.has(staged!)) return failed(1, `${staged}: not staged`);
      files.add(dest!);
      if (removed === staged) files.delete(staged!);
      return ok();
    }
    return ok();
  }
}

function lastPositional(args: readonly string[]): string {
  for (let i = args.length - 1; i >= 0; i--) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) return arg;
  }
  return "";
}

function splitGuestPath(
  value: string,
): { instance: string; path: string } | undefined {
  const colon = value.indexOf(":");
  // A colon at position 0 or absent, or a path-like prefix, means host-side.
  if (colon <= 0 || value.slice(0, colon).includes("/")) return undefined;
  return { instance: value.slice(0, colon), path: value.slice(colon + 1) };
}
