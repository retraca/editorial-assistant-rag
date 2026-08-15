import type { Chunk } from '../ingest/chunk.js';
import { getBm25, retrieve } from './hybrid.js';
import type { Trace } from '../trace.js';

/**
 * Entity follow-up: a structural fix for multi-hop retrieval.
 *
 * The measured failure (D-29, needle m1): "Who controlled the living at
 * Cranmere, and what happened to his money?" The agent searched twice, both
 * times on "Cranmere". The only entity in the question. The passage answering
 * the second half is about *Sir Marcus Vane* and never mentions Cranmere, so no
 * rephrasing of the original question could reach it. Searching "Sir Marcus
 * Vane" returns it at rank 1.
 *
 * The name is only learnable *from the first result*. A prompt instruction to
 * "chain on what you learn" was tried and did not work under realistic
 * conditions, so this does it in code instead: pull rare proper nouns out of the
 * retrieved passages and search for them.
 *
 * The IDF gate is what makes this safe rather than noisy. Every passage in these
 * books names somebody, "Elizabeth" appears in 413 chunks, and chasing it would
 * flood every query with irrelevance. "Sir Marcus Vane" appears in 2. Only
 * entities rarer than the threshold are worth a follow-up, which is exactly the
 * set that carries new information.
 *
 * Costs one embedding round-trip per expansion (~300ms, run concurrently), no
 * LLM call. Bounded at MAX_EXPANSIONS. See DECISIONS.md D-31.
 */

const MAX_EXPANSIONS = 2;
/** Entities must be at least this rare. ~5.5 corresponds to a handful of chunks. */
const MIN_IDF = Number(process.env.EXPAND_MIN_IDF ?? 5.0);
const ENABLED = (process.env.ENTITY_EXPANSION ?? 'true') === 'true';

/** Capitalised runs, optionally with a title, that are not sentence-initial noise. */
const ENTITY_RE = /\b((?:Mr|Mrs|Miss|Sir|Lady|Dr|Lord|Colonel|Captain)\.?\s+)?([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){0,2})\b/g;

export function candidateEntities(passages: Chunk[], query: string): string[] {
  const bm25 = getBm25();
  const inQuery = new Set(query.toLowerCase().match(/[a-z]+/g) ?? []);
  const seen = new Map<string, number>();

  for (const p of passages) {
    for (const m of p.text.matchAll(ENTITY_RE)) {
      const name = (m[2] ?? '').trim();
      if (!name) continue;
      const tokens = name.toLowerCase().split(/\s+/);
      // Skip anything the question already contains. That is not new information.
      if (tokens.every((t) => inQuery.has(t))) continue;
      // Rarity is measured on the surname / last token, which carries the signal.
      const idf = bm25.maxIdf(tokens[tokens.length - 1]);
      if (idf < MIN_IDF) continue;
      const full = ((m[1] ?? '') + name).trim();
      if (!seen.has(full) || (seen.get(full) ?? 0) < idf) seen.set(full, idf);
    }
  }

  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANSIONS)
    .map(([name]) => name);
}

/**
 * Returns extra passages found by searching for rare entities that appear in
 * `passages` but not in `query`. Empty when nothing qualifies, which is the
 * common case. This fires only when a result introduces a genuinely new name.
 */
export async function expandOnEntities(
  query: string,
  passages: Chunk[],
  k: number,
  trace?: Trace,
): Promise<Chunk[]> {
  if (!ENABLED || !passages.length) return [];
  const entities = candidateEntities(passages, query);
  if (!entities.length) return [];

  const have = new Set(passages.map((p) => p.id));
  const results = await Promise.all(
    entities.map((e) => retrieve({ query: e, k: Math.min(k, 4), trace })),
  );

  const extra: Chunk[] = [];
  for (const hits of results) {
    for (const h of hits) {
      if (!have.has(h.chunk.id)) {
        have.add(h.chunk.id);
        extra.push(h.chunk);
      }
    }
  }
  return extra;
}
