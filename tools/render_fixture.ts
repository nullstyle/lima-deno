/**
 * Regenerate the committed kitchen-sink golden fixture from the renderer.
 * Run after an INTENTIONAL renderer byte-contract change:
 *
 *     deno run --allow-write=tests/fixtures tools/render_fixture.ts
 *
 * @module
 */

import { renderLimaYaml } from "../src/config/render.ts";
import {
  KITCHEN_SINK,
  KITCHEN_SINK_OPTIONS,
} from "../tests/unit/render_test.ts";

const target = new URL("../tests/fixtures/kitchen-sink.yaml", import.meta.url);
await Deno.writeTextFile(
  target,
  renderLimaYaml(KITCHEN_SINK, KITCHEN_SINK_OPTIONS),
);
console.log(`wrote ${target.pathname}`);
