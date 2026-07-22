/**
 * Display formatting for {@linkcode ImageEvent}.
 *
 * The library never logs and never decides when you print — this returns a
 * string and touches no sink, so the caller keeps both the sink and the
 * throttling policy.
 *
 * @module
 */

import type { ImageEvent } from "./types.ts";

/**
 * Render one {@linkcode ImageEvent} as a display line, or `undefined` when
 * there is nothing worth printing.
 *
 * `digest-progress` always yields `undefined`: it fires once per hashed
 * chunk, so whether that becomes a bar, a percentage, or nothing at all is a
 * decision only the caller can make. Read
 * {@linkcode ImageEvent.bytesHashed}/`totalBytes` directly to render one.
 *
 * The phase line deliberately omits the instance name — repeating it across
 * all nine phases is noise. Set {@linkcode ImageBuildSpec.name} if you want a
 * findable builder.
 *
 * @example
 * ```ts
 * await buildImage(lima, spec, {
 *   onEvent: (event) => {
 *     const line = formatImageEvent(event);
 *     if (line !== undefined) console.log(`  · ${line}`);
 *   },
 * });
 * ```
 */
export function formatImageEvent(event: ImageEvent): string | undefined {
  switch (event.type) {
    case "phase":
      return event.phase;
    case "step":
      return `${event.index + 1}/${event.count} ${
        event.comment ?? `step ${event.index + 1}`
      }`;
    default:
      return undefined;
  }
}
