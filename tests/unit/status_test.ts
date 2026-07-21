import { assertEquals, assertThrows } from "@std/assert";
import { LimaOutputError } from "../../src/errors.ts";
import { parseInstanceInfo, parseInstanceList } from "../../src/status.ts";

const FIXTURES = new URL("../fixtures/", import.meta.url);

Deno.test("parses a current-release list --json line", async () => {
  const jsonl = await Deno.readTextFile(
    new URL("list-lima-1.0.jsonl", FIXTURES),
  );
  const [running, broken] = parseInstanceList(jsonl);
  assertEquals(running!.name, "default");
  assertEquals(running!.status, "Running");
  assertEquals(running!.vmType, "vz");
  assertEquals(running!.cpus, 4);
  assertEquals(running!.memory, 4294967296);
  assertEquals(running!.sshLocalPort, 60022);
  assertEquals(running!.hostAgentPid, 12345);
  assertEquals(running!.driverPid, 12346);
  assertEquals(running!.errors, []);
  assertEquals(running!.protected, false);
  assertEquals(broken!.status, "Broken");
  assertEquals(broken!.errors, ["hostagent is not running"]);
  assertEquals(broken!.protected, true);
});

Deno.test("future fields degrade gracefully and survive in raw", async () => {
  const jsonl = await Deno.readTextFile(new URL("list-future.jsonl", FIXTURES));
  const [info] = parseInstanceList(jsonl);
  assertEquals(info!.status, "Hibernated"); // open union: unknown state flows through
  assertEquals(info!.cpus, undefined); // mistyped known field degrades
  assertEquals(info!.memory, 8589934592);
  assertEquals(info!.errors, ["one real error", "42"]); // nulls dropped, non-strings stringified
  assertEquals(info!.raw.newTelemetryField, { nested: true }); // nothing dropped
});

Deno.test("a line with no name throws LimaOutputError", () => {
  assertThrows(
    () => parseInstanceInfo(`{"status":"Running"}`),
    LimaOutputError,
  );
});

Deno.test("an unparseable line throws LimaOutputError with the text", () => {
  const error = assertThrows(
    () => parseInstanceInfo("not json"),
    LimaOutputError,
  );
  assertEquals(error.output, "not json");
});

Deno.test("a non-object line throws LimaOutputError", () => {
  assertThrows(() => parseInstanceInfo("[1,2]"), LimaOutputError);
});

Deno.test("parseInstanceList skips blank lines", () => {
  const list = parseInstanceList(`\n{"name":"a","status":"Stopped"}\n\n`);
  assertEquals(list.length, 1);
  assertEquals(list[0]!.name, "a");
  assertEquals(list[0]!.status, "Stopped");
});

Deno.test("missing status degrades to Unknown", () => {
  assertEquals(parseInstanceInfo(`{"name":"a"}`).status, "Unknown");
});
