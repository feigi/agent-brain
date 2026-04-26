import type { CountsByKind, EntityKind } from "./types.js";
import { ENTITY_KINDS } from "./types.js";

export interface CountDiff {
  kind: EntityKind;
  source: number;
  destination: number;
}

export function compareCounts(
  source: CountsByKind,
  destination: CountsByKind,
): CountDiff[] {
  const diffs: CountDiff[] = [];
  for (const kind of ENTITY_KINDS) {
    if (source[kind] !== destination[kind]) {
      diffs.push({
        kind,
        source: source[kind],
        destination: destination[kind],
      });
    }
  }
  return diffs;
}
