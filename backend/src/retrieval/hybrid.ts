import { config } from '../config.js';
import { embed } from '../azure.js';
import type { Trace } from '../trace.js';
import type { Chunk } from '../ingest/chunk.js';
import { store, type Scored } from './store.js';
import { BM25 } from './bm25.js';

/**
 * Hybrid retrieval: dense (embeddings) + sparse (BM25), fused with Reciprocal
 * Rank Fusion.
 *
 * RRF fuses on *rank*, not score. That matters because a cosine similarity
 * (bounded 0-1, typically 0.3-0.6 here) and a BM25 score (unbounded, scales
 * with IDF and query length) are not on a comparable scale, normalising them
 * against each other would need a tuning constant per corpus. RRF needs none.
 * See DECISIONS.md D-07.
 */

let bm25: BM25 | null = null;
export function getBm25(): BM25 {
  if (!bm25) bm25 = new BM25(store.chunks);
  return bm25;
}

export interface RetrievalOpts {
  query: string;
  k?: number;
  bookId?: string;
  trace?: Trace;
  /** 'dense' and 'sparse' exist so the eval can ablate one arm and measure what fusion buys. */
  mode?: 'hybrid' | 'dense' | 'sparse';
}

export interface FusedHit extends Scored {
  denseRank: number | null;
  sparseRank: number | null;
}

export async function retrieve(opts: RetrievalOpts): Promise<FusedHit[]> {
  const k = opts.k ?? config.retrieval.k;
  const mode = opts.mode ?? 'hybrid';
  const filter = opts.bookId ? (c: Chunk) => c.bookId === opts.bookId : undefined;

  // Over-fetch each arm so the fusion has enough candidates to reorder.
  const pool = Math.max(k * 3, 24);

  let dense: Scored[] = [];
  if (mode !== 'sparse') {
    const [qvec] = await embed([opts.query], opts.trace, 'embed:query');
    dense = opts.trace
      ? await opts.trace.span('search:dense', async () => store.dense(qvec, pool, filter))
      : store.dense(qvec, pool, filter);
  }

  let sparse: Scored[] = [];
  if (mode !== 'dense') {
    sparse = opts.trace
      ? await opts.trace.span('search:sparse', async () => getBm25().search(opts.query, pool, filter))
      : getBm25().search(opts.query, pool, filter);
  }

  const fuse = () => rrf(dense, sparse, k, config.retrieval.rrfK);
  const fused = opts.trace ? await opts.trace.span('search:fuse', async () => fuse()) : fuse();
  return withNeighbours(fused, opts.bookId);
}

/**
 * Adds the chunks immediately before and after the strongest hits.
 *
 * A retrieved chunk is a window onto a continuous text, and the sentence that
 * completes its meaning is frequently just outside it. Overlap tries to solve
 * that at index time and mostly cannot: it heals a seam only when both halves
 * of what is needed fall inside the carried window. This solves it at query
 * time, where the whole neighbouring chunk is available. See DECISIONS.md D-68.
 *
 * Neighbours are appended rather than ranked, because they were not retrieved
 * on merit and should not displace anything that was.
 */
function withNeighbours(hits: FusedHit[], bookId?: string): FusedHit[] {
  const n = config.retrieval.neighbours;
  if (!n || !hits.length) return hits;
  const have = new Set(hits.map((h) => h.chunk.id));
  const extra: FusedHit[] = [];
  for (const h of hits.slice(0, n)) {
    for (const step of [-1, 1]) {
      const c = h.chunk;
      const id = `${c.bookId}:${c.chapterIndex}:${c.chunkIndex + step}`;
      const neighbour = store.get(id);
      if (!neighbour || have.has(id)) continue;
      if (bookId && neighbour.bookId !== bookId) continue;
      have.add(id);
      extra.push({ chunk: neighbour, score: 0, denseRank: null, sparseRank: null });
    }
  }
  return [...hits, ...extra];
}

/**
 * `lookup` exists so this function can be tested without a built index. It
 * defaults to the store, which is what every caller uses; passing it makes the
 * fusion a pure function of its inputs. See DECISIONS.md D-54.
 */
export function rrf(
  dense: Scored[],
  sparse: Scored[],
  k: number,
  rrfK: number,
  lookup: (id: string) => Chunk | undefined = (id) => store.get(id),
): FusedHit[] {
  const denseRank = new Map(dense.map((h, i) => [h.chunk.id, i]));
  const sparseRank = new Map(sparse.map((h, i) => [h.chunk.id, i]));
  const ids = new Set([...denseRank.keys(), ...sparseRank.keys()]);

  const fused: FusedHit[] = [];
  for (const id of ids) {
    const dr = denseRank.get(id);
    const sr = sparseRank.get(id);
    const score =
      (dr === undefined ? 0 : 1 / (rrfK + dr + 1)) + (sr === undefined ? 0 : 1 / (rrfK + sr + 1));
    const chunk = lookup(id);
    if (!chunk) continue;
    fused.push({ chunk, score, denseRank: dr ?? null, sparseRank: sr ?? null });
  }
  return fused.sort((a, b) => b.score - a.score).slice(0, k);
}
