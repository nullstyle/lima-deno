# Changelog

All notable changes to `@nullstyle/lima` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project aims to
follow [semantic versioning](https://semver.org/) from 1.0 onward — until then,
breaking changes ride a minor bump.

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
