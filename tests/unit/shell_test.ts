import { assertEquals } from "@std/assert";
import {
  buildShellArgv,
  shellQuote,
  strictWrap,
  sudoWrap,
} from "../../src/shell.ts";

Deno.test("shellQuote wraps in single quotes", () => {
  assertEquals(shellQuote("plain"), "'plain'");
});

Deno.test("shellQuote escapes embedded single quotes with '\\''", () => {
  assertEquals(shellQuote("it's"), `'it'\\''s'`);
});

Deno.test("strictWrap prefixes set -euo pipefail", () => {
  assertEquals(strictWrap("echo hi"), "set -euo pipefail; echo hi");
});

Deno.test("sudoWrap produces the proven privileged form", () => {
  assertEquals(
    sudoWrap("set -euo pipefail; echo hi"),
    `sudo -E bash -lc 'set -euo pipefail; echo hi'`,
  );
});

Deno.test("sudoWrap round-trips scripts containing single quotes", () => {
  assertEquals(
    sudoWrap(`echo 'q'`),
    `sudo -E bash -lc 'echo '\\''q'\\'''`,
  );
});

Deno.test("sudoWrap -u user and custom sudo bin", () => {
  assertEquals(
    sudoWrap("id", { sudoBin: "/usr/bin/sudo", user: "app" }),
    `/usr/bin/sudo -E -u app bash -lc 'id'`,
  );
});

Deno.test("buildShellArgv matches the proven limactl shell shape", () => {
  assertEquals(buildShellArgv("vm1", "set -euo pipefail; echo hi"), [
    "shell",
    "vm1",
    "--",
    "bash",
    "-lc",
    "set -euo pipefail; echo hi",
  ]);
});

Deno.test("buildShellArgv places --workdir before the instance", () => {
  assertEquals(buildShellArgv("vm1", "pwd", { workdir: "/srv" }), [
    "shell",
    "--workdir",
    "/srv",
    "vm1",
    "--",
    "bash",
    "-lc",
    "pwd",
  ]);
});
