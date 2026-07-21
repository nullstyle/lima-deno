import { assertEquals, assertStringIncludes } from "@std/assert";
import { publishReadinessFailures } from "../../tools/check_publish.ts";

const READY = {
  name: "@nullstyle/lima",
  version: "0.1.0",
  exports: { ".": "./mod.ts" },
  imports: { "@std/assert": "jsr:@std/assert@^1" },
  publish: {
    include: [
      "mod.ts",
      "src/**",
      "testing/**",
      "README.md",
      "CHANGELOG.md",
      "LICENSE",
      "deno.json",
    ],
  },
};

Deno.test("a release-shaped deno.json has no failures", () => {
  assertEquals(publishReadinessFailures(READY), []);
});

Deno.test("the real deno.json passes the gate", async () => {
  const real = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  );
  assertEquals(publishReadinessFailures(real), []);
});

Deno.test("wrong name, dev version, and missing root export are blockers", () => {
  const failures = publishReadinessFailures({
    ...READY,
    name: "@nullstyle/other",
    version: "0.0.0",
    exports: {},
  });
  assertEquals(failures.length, 3);
  assertStringIncludes(failures[0]!, "@nullstyle/lima");
});

Deno.test("a missing allowlist entry is a blocker", () => {
  const failures = publishReadinessFailures({
    ...READY,
    publish: { include: ["mod.ts"] },
  });
  assertEquals(
    failures.filter((f) => f.includes("publish.include")).length,
    5,
  );
});

Deno.test("dev-only import specifiers are blockers", () => {
  const failures = publishReadinessFailures({
    ...READY,
    imports: {
      "dep": "./vendor/dep/mod.ts",
      "web": "https://example.com/m.ts",
    },
  });
  assertEquals(failures.length, 2);
});

Deno.test("a non-object rejects wholesale", () => {
  assertEquals(publishReadinessFailures(null), ["deno.json is not an object"]);
});
