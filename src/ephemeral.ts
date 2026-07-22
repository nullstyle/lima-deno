/**
 * Run something against a throwaway instance and clean it up.
 *
 * Its own module because {@linkcode import("./instance.ts").LimaInstance}
 * cannot reach {@linkcode import("./limactl.ts").Limactl} without a cycle.
 * Every import here is type-only, so this adds no coupling.
 *
 * @module
 */

import type { CreateOptions, CreateSource, Limactl } from "./limactl.ts";
import type { LimaInstance, WaitReadyOptions } from "./instance.ts";

/** Options for {@linkcode withInstance}. */
export interface WithInstanceOptions extends CreateOptions {
  /** Readiness options after create, or `false` to skip the wait. @default {} */
  readonly waitReady?: WaitReadyOptions | false;
  /** Keep the instance when `fn` resolves. @default false */
  readonly keepOnSuccess?: boolean;
  /** Keep the instance when readiness or `fn` throws. @default false */
  readonly keepOnFailure?: boolean;
}

/**
 * Create `name` from `source`, wait for readiness, run `fn`, delete.
 *
 * OWNERSHIP: this deletes `name`. `limactl start --name=X` reuses an existing
 * instance rather than failing, so pointing this at a VM you care about will
 * destroy it — pass a unique throwaway name.
 *
 * On a throw from readiness or `fn` the delete is best effort and swallowed,
 * so the original error always wins (matching `buildImage`'s cleanup). On
 * success a failed delete propagates, because nothing is being masked. A
 * failure inside `lima.create` itself deletes nothing: ownership was never
 * established.
 *
 * @example
 * ```ts
 * const os = await withInstance(lima, "probe-1", { template: "ubuntu-24.04" }, async (vm) => {
 *   const result = await vm.exec("cat /etc/os-release", { check: true });
 *   return result.stdout;
 * });
 * ```
 */
export async function withInstance<T>(
  lima: Limactl,
  name: string,
  source: CreateSource,
  fn: (vm: LimaInstance) => T | Promise<T>,
  options: WithInstanceOptions = {},
): Promise<T> {
  const {
    waitReady = {},
    keepOnSuccess = false,
    keepOnFailure = false,
    ...create
  } = options;

  // Outside the try: a create that never succeeded leaves nothing to own,
  // and deleting `name` here could destroy an instance we did not make.
  const vm = await lima.create(name, source, create);

  let result: T;
  try {
    if (waitReady !== false) await vm.waitReady(waitReady);
    result = await fn(vm);
  } catch (error) {
    if (!keepOnFailure) {
      await vm.delete().catch(() => {});
    }
    throw error;
  }
  if (!keepOnSuccess) await vm.delete();
  return result;
}
