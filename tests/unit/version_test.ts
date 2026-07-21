import { assertEquals, assertThrows } from "@std/assert";
import { LimaOutputError } from "../../src/errors.ts";
import {
  compareLimactlVersions,
  parseLimactlVersion,
} from "../../src/version.ts";

Deno.test("parses a release version", () => {
  const version = parseLimactlVersion("limactl version 1.0.6\n");
  assertEquals(version, { raw: "1.0.6", major: 1, minor: 0, patch: 6 });
});

Deno.test("parses a v-prefixed and git-describe dev build", () => {
  const version = parseLimactlVersion("limactl version v1.1.0-12-gabc1234");
  assertEquals(version.raw, "1.1.0-12-gabc1234");
  assertEquals(version.major, 1);
  assertEquals(version.minor, 1);
  assertEquals(version.prerelease, "12-gabc1234");
});

Deno.test("parses a bare version string", () => {
  assertEquals(parseLimactlVersion("0.23.2").minor, 23);
});

Deno.test("unrecognizable output throws LimaOutputError carrying the text", () => {
  const error = assertThrows(
    () => parseLimactlVersion("not a version"),
    LimaOutputError,
  );
  assertEquals(error.output, "not a version");
});

Deno.test("comparison orders triples numerically (10 > 9)", () => {
  const a = parseLimactlVersion("1.10.0");
  const b = parseLimactlVersion("1.9.9");
  assertEquals(compareLimactlVersions(a, b), 1);
  assertEquals(compareLimactlVersions(b, a), -1);
  assertEquals(compareLimactlVersions(a, a), 0);
});

Deno.test("a prerelease sorts before its release", () => {
  const pre = parseLimactlVersion("1.1.0-rc1");
  const release = parseLimactlVersion("1.1.0");
  assertEquals(compareLimactlVersions(pre, release), -1);
  assertEquals(compareLimactlVersions(release, pre), 1);
});
