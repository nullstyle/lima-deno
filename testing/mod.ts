/**
 * In-process test doubles for code that drives Lima through this library —
 * no VM, no `limactl` binary, runnable anywhere Deno runs.
 *
 * {@linkcode FakeLimactl} implements the
 * {@linkcode import("../src/runner.ts").CommandRunner} seam: inject it in
 * place of the real runner and assert the exact `limactl` argv sequence via
 * {@linkcode FakeLimactl.commandLines}, while its in-memory state machine
 * keeps `list`/`start`/`stop`/`cp`/`shell` answers coherent.
 *
 * @example Testing code that creates and probes an instance
 * ```ts
 * import { Limactl } from "@nullstyle/lima";
 * import { FakeLimactl } from "@nullstyle/lima/testing";
 *
 * const fake = new FakeLimactl();
 * const lima = new Limactl({ runner: fake });
 * const vm = await lima.create("demo", { template: "ubuntu-24.04" });
 * console.log(await vm.isRunning()); // true
 * console.log(fake.commandLines());
 * // ["limactl start --name=demo --tty=false template:ubuntu-24.04", …]
 * ```
 *
 * @module
 */

export {
  failed,
  type FakeDiskState,
  type FakeInstanceState,
  FakeLimactl,
  type GuestScriptCall,
  ok,
  type RecordedCall,
} from "./fake_limactl.ts";
