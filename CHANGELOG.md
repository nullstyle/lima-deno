# Changelog

All notable changes to `@nullstyle/lima` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project aims to
follow [semantic versioning](https://semver.org/) from 1.0 onward — until then,
breaking changes ride a minor bump.

## [0.2.0] — Unreleased

### Added

- The `./image` subpath (also re-exported from the root): build custom Lima
  images programmatically.
  - `captureImage(instance, …)` — bake a stopped instance's disk
    (`~/.lima/<name>/disk`, the Lima 2.x layout) into a standalone image: qcow2
    (zlib-compressed by default; needs `qemu-img`) or raw (cloned with `cp`,
    zero host dependencies from vz disks), with atomic output and a `sha256:`
    digest. ASIF and Lima 1.x diffdisk layouts are detected and refused.
  - `buildImage(lima, spec)` — the declarative orchestrator: ephemeral `--plain`
    builder VM → typed provision steps (`run`/`copyIn`/`fn`) → graded seal
    (`DEFAULT_SEAL_SCRIPT`: host keys, machine-id, authorized_keys, caches;
    overridable/skippable) → capture → cleanup (`keepOnFailure` keeps the
    builder). Failures wrap in `ImageBuildError` with the phase and step.
    Cross-arch builds via `arch:` (enforces `vmType: "qemu"` + QEMU in
    preflight, 30-minute TCG readiness default).
  - `toImageSpec`/`configFromImage` — turn a `BuiltImage` into a pinned,
    single-entry `images:` config (digest mismatches fail loudly); `hostArch()`;
    `sha256File` (streaming, via `@std/crypto`).
  - `ImageStore` — a local catalog: digest-named files plus a deterministic,
    atomically-written `manifest.json`; `put`/`get`/`list`/`remove`/`resolve`.
  - Progress via a typed `onEvent` callback (phases, steps, digest progress) —
    the library still never logs.
- `base: { image }` — derive a build from an image you already built.
  `buildImage` pins it by digest, sizes the builder's disk to the base's own
  virtual size (`diskFloorGiB` — never smaller, since Lima refuses to shrink a
  disk, and never silently inflated to the builder default either; a smaller
  explicit `create.diskGiB` throws `ImageDiskFloorError`), and infers its arch —
  which also fixes a hole where a derived cross-arch build skipped its preflight
  and failed inside limactl minutes later. `resolveImageBase` exposes the whole
  compilation as a pure, assertable function.
- `formatImageEvent(event)` — renders one progress event, or `undefined` when
  there is nothing worth printing (`digest-progress` fires per hashed chunk, so
  throttling stays yours). The library still never logs.
- `ImageStore.latest(prefix?)` and `list({ prefix, order })` — ordering by the
  `createdAt` already in the manifest, so image generations need no naming
  convention and `gen10` cannot sort before `gen2`. No manifest schema change.
- `withInstance(lima, name, source, fn, options?)` — create, wait, run, delete,
  with `keepOnSuccess`/`keepOnFailure`. It owns and deletes `name`.
- `CreateOptions.arch` → `limactl start --arch=…`.
- `examples/devbox_image.ts` — the image lifecycle end to end: build, derive a
  new generation from the last, catalog it, boot one, rebase to collapse layers.
  Not published; it lives in the repo.
- `tools/image_smoke.ts` (`deno task smoke:image`): the manual real-VM gate —
  build → tamper-check the digest pin → boot a derived VM → assert baked
  provisioning, fresh machine-id, and disk growth → derive a second generation
  from the built image and prove both generations' provisioning survives →
  assert the disk floor is refused in preflight; cross-arch section behind
  `IMAGE_SMOKE_CROSS_ARCH=1`.

### Changed

- First runtime dependencies: `@std/crypto` (streaming digests) and
  `@nullstyle/qemu-img` (the qemu-img driver; its runner seam is structurally
  identical to this package's). Public option types reference it only
  structurally (`QemuImgLike`), and its two error classes are re-exported for
  `catch` convenience.
- The `test` task now also grants `--allow-write=tests/.tmp` (image tests
  exercise real files there).

## [0.1.0] — 2026-07-21

### Added

- `Limactl` client: version probe/floor (`LIMA_COMPAT`), typed `list --json`
  status (`InstanceInfo`, open-union `InstanceStatus`), instance creation from a
  template file, a builtin `template:` name, a URL, raw YAML, or a typed
  `LimaConfig` (piped via stdin `-`), plus `disk create/ls/resize/delete` and a
  recorded `raw()` escape hatch.
- `LimaInstance` handle: `start`/`stop`/`delete`/`restart`/`factory-reset`/
  `protect`/`unprotect`, strict/sudo guest `exec` (env, user, workdir), raw
  `command`, `copyIn`/`copyOut`, root-owned delivery via `copyInAsRoot` (stage +
  `sudo install`), `waitReady` (Broken fails fast), and `snapshot` operations
  (qemu instances).
- `./config`: typed `LimaConfig` covering the useful `lima.yaml` surface with a
  `raw` escape hatch, rendered by `renderLimaYaml` — deterministic,
  dependency-free, comment-capable YAML whose byte output is a semver contract.
- `./runner`: the injectable `CommandRunner` subprocess seam
  (`DenoCommandRunner` with byte-accurate capture capping, AbortSignal + timeout
  support, `runChecked`, typed `CommandError`/`CommandAbortedError`).
- `./testing`: `FakeLimactl` — a recording, stateful in-memory limactl with
  `protected` extension hooks (`onGuestScript`, `onCommand`) and one-shot
  `stub()` failure injection.

Extracted and generalized from the proven Lima layer of
[`@nullstyle/studiobox`](https://github.com/nullstyle/studiobox) (its
`src/cli/exec.ts` / `host_env.ts` / `lima_template.ts`); the `limactl` argv
shapes are byte-identical to the ones that layer shipped, with one deliberate
deviation: the `copyInAsRoot` staging prefix is de-branded to `/tmp/.lima-cp-`
(exported as `LIMA_CP_STAGING_PREFIX`, overridable per call via
`stagingPrefix`).

Targets `limactl` >= 2.1.0 (`LIMA_COMPAT.minimum`): the create path uses the
opaque `template:NAME` locator and repeatable `--set` (limactl >= 2.0) and
`--nested-virt` (>= 2.1). On older limactl, `requireVersion()` fails with a
clear error.
