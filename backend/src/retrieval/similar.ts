import { chat, dot } from '../azure.js';
import type { Trace } from '../trace.js';
import type { Chunk } from '../ingest/chunk.js';
import { store } from './store.js';
import { retrieve } from './hybrid.js';
import { rerank } from './rerank.js';
import { config } from '../config.js';
import { findReuse, type ReuseMatch } from './reuse.js';

/**
 * Cross-book passage similarity: reviewing potential similarities between
 * authors' work.
 *
 * This is a different retrieval shape from Q&A. Q&A is query -> chunk. This is
 * chunk -> chunk across two corpora, which needs three things the naive version
 * gets wrong:
 *
 *   1. Diversity. The raw top-N pairs cluster in one or two chapters (both
 *      books have a ball scene, a proposal scene). We keep the best pair per
 *      chapter-pair so an editor sees breadth instead of ten views of the same
 *      passage. See DECISIONS.md D-08.
 *   2. Calibration. Cosine between two 19th-century domestic novels is high by
 *      default, genre and register alone score ~0.5. A score without a
 *      baseline is not evidence, so we return the corpus baseline alongside it.
 *   3. Judgement. A number cannot tell an editor whether a pair is a genuine
 *      parallel or two authors independently describing a drawing room. An LLM
 *      pass classifies each pair and must quote both sides to justify it.
 */

export interface PassagePair {
  a: Chunk;
  b: Chunk;
  similarity: number;
  verdict?: {
    relationship: 'parallel_scene' | 'shared_theme' | 'similar_phrasing' | 'coincidental';
    confidence: 'high' | 'medium' | 'low';
    explanation: string;
    quoteA: string;
    quoteB: string;
  };
}

export interface VerbatimMatch {
  aId: string; bId: string; aChapter: string; bChapter: string;
  sharedShingles: number; jaccard: number; phrase: string;
}

export interface SimilarResult {
  pairs: PassagePair[];
  baselineSimilarity: number;
  candidatesCompared: number;
  verbatim: { matches: VerbatimMatch[]; shinglesIndexed: number };
}

export interface SimilarOpts {
  bookA: string;
  bookB: string;
  theme?: string;
  topN?: number;
  judge?: boolean;
  trace?: Trace;
}

/** Mean pairwise similarity of a random sample. The "everything looks similar" floor. */
function baseline(idxA: number[], idxB: number[], sample = 60): number {
  const strideA = Math.max(1, Math.floor(idxA.length / sample));
  const strideB = Math.max(1, Math.floor(idxB.length / sample));
  let total = 0;
  let n = 0;
  for (let i = 0; i < idxA.length; i += strideA) {
    for (let j = 0; j < idxB.length; j += strideB) {
      total += dot(store.vectorAt(idxA[i]), store.vectorAt(idxB[j]));
      n++;
    }
  }
  return n ? total / n : 0;
}

export async function findSimilarPassages(
  opts: SimilarOpts,
): Promise<SimilarResult> {
  const topN = opts.topN ?? 5;

  const idxOf = (bookId: string) =>
    store.chunks.map((c, i) => (c.bookId === bookId ? i : -1)).filter((i) => i >= 0);

  const allA = idxOf(opts.bookA);
  const idxB = idxOf(opts.bookB);
  if (!allA.length || !idxB.length) {
    throw new Error(`Unknown book id: ${!allA.length ? opts.bookA : opts.bookB}`);
  }

  // A theme narrows BOTH sides to passages about that theme.
  //
  // Narrowing only side A looked right and was not: each A passage was matched
  // to its nearest neighbour anywhere in B, so a search for "carriages" returned
  // a carriage scene paired with whatever happened to sit closest to it, often
  // nothing to do with the theme. The reader sees a themed query and off-theme
  // pairs, with no way to tell why.
  let idxA = allA;
  let searchB = idxB;
  if (opts.theme) {
    // Reranked, because first-stage retrieval drifts badly on adjective+noun
    // themes. "important meals" becomes one averaged vector in which "important"
    //, loud and generic, drowns out "meals", and the theme filled with
    // important letters and important marriages. Measured on this exact query:
    // 4/8 of the top passages were about food before reranking, 8/8 after.
    const fetchK = config.retrieval.rerank ? 40 : 24;
    const [rawA, rawB] = await Promise.all([
      retrieve({ query: opts.theme, k: fetchK, bookId: opts.bookA, trace: opts.trace }),
      retrieve({ query: opts.theme, k: fetchK, bookId: opts.bookB, trace: opts.trace }),
    ]);
    const [hitsA, hitsB] = config.retrieval.rerank
      ? await Promise.all([
          rerank(opts.theme, rawA, 24, opts.trace),
          rerank(opts.theme, rawB, 24, opts.trace),
        ])
      : [rawA, rawB];
    idxA = hitsA.map((h) => store.indexOf(h.chunk.id)!).filter((i) => i !== undefined);
    const narrowed = hitsB.map((h) => store.indexOf(h.chunk.id)!).filter((i) => i !== undefined);
    if (narrowed.length) searchB = narrowed;
  }

  const scan = async () => {
    const pairs: PassagePair[] = [];
    for (const i of idxA) {
      const va = store.vectorAt(i);
      let best = -1;
      let bestJ = -1;
      for (const j of searchB) {
        const s = dot(va, store.vectorAt(j));
        if (s > best) {
          best = s;
          bestJ = j;
        }
      }
      if (bestJ >= 0) pairs.push({ a: store.chunks[i], b: store.chunks[bestJ], similarity: best });
    }
    return pairs;
  };

  const pairs = opts.trace ? await opts.trace.span('similar:scan', scan) : await scan();

  // Diversity filter: a chapter may appear once on each side.
  //
  // Keying on the chapter *pair* was not enough. Three different Austen
  // chapters all matched the same Alcott chapter (Aunt March, the interfering
  // relative) and consumed every slot in a top-3. That repetition is itself an
  // interesting signal, but it belongs in a drill-down, not in the one list an
  // editor sees first, here it just crowds out unrelated findings.
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const diverse = pairs
    .sort((x, y) => y.similarity - x.similarity)
    .filter((p) => {
      if (usedA.has(p.a.chapterIndex) || usedB.has(p.b.chapterIndex)) return false;
      usedA.add(p.a.chapterIndex);
      usedB.add(p.b.chapterIndex);
      return true;
    })
    .slice(0, topN);

  const base = baseline(allA, idxB);

  if (opts.judge !== false && diverse.length) {
    await judgePairs(diverse, base, opts.trace);
  }

  // Verbatim check runs alongside the semantic one and answers a different
  // question: thematic resemblance vs shared wording. An editor needs to know
  // which of the two fired. See DECISIONS.md D-23.
  const reuse = opts.trace
    ? await opts.trace.span('similar:verbatim', async () =>
        findReuse(opts.bookA, opts.bookB, { minShared: 2, topN: 5 }),
      )
    : findReuse(opts.bookA, opts.bookB, { minShared: 2, topN: 5 });

  return {
    pairs: diverse,
    baselineSimilarity: Number(base.toFixed(4)),
    candidatesCompared: idxA.length * searchB.length,
    verbatim: {
      matches: reuse.matches.map((m: ReuseMatch) => ({
        aId: m.a.id, bId: m.b.id,
        aChapter: m.a.chapterTitle, bChapter: m.b.chapterTitle,
        sharedShingles: m.sharedShingles,
        jaccard: Number(m.jaccard.toFixed(4)),
        phrase: m.longestSharedPhrase,
      })),
      shinglesIndexed: reuse.shinglesIndexed,
    },
  };
}

/**
 * Plain-language strength, measured from the corpus floor.
 *
 * A cosine of 0.6491 tells an editor nothing. It is the "raw probability dump"
 * that UX research names as the standard mistake. What matters is how far above
 * the genre floor it sits, said in words. Numbers stay available to the API and
 * the Compare view; the assistant only ever receives this.
 */
export function strengthOf(similarity: number, baseline: number): string {
  const lift = similarity - baseline;
  if (lift < 0.05) return 'no more alike than any two passages picked at random from these books';
  if (lift < 0.15) return 'slightly closer than average, but weak';
  if (lift < 0.25) return 'clearly closer than average, worth reading';
  return 'much closer than average. A strong resemblance';
}

/** Internal category names are for the code, not for an editor. */
export function relationshipInWords(rel?: string): string {
  switch (rel) {
    case 'parallel_scene':   return 'the same kind of scene';
    case 'shared_theme':     return 'the same idea, handled differently';
    case 'similar_phrasing': return 'closely similar wording';
    case 'coincidental':     return 'no real connection, shared genre only';
    default:                 return 'not assessed';
  }
}

const JUDGE_SYSTEM = `You assess whether two passages from different novels are genuinely related.

You will be given pairs, each with a cosine similarity score and the corpus baseline similarity.
The baseline is what two RANDOM passages from these books score. Both are 19th-century domestic
novels, so shared register, period diction and drawing-room settings are expected and are NOT
evidence of a relationship. Only a score meaningfully above the baseline is worth attention.

Classify each pair:
- "parallel_scene": the same narrative beat (a proposal, a first meeting, an illness)
- "shared_theme": the same idea treated differently (marriage as economics, sisterhood)
- "similar_phrasing": genuinely close wording, the only category suggesting derivation
- "coincidental": similarity is genre and register only, use this freely, it is the common case

Quote verbatim from each passage to justify the call. Never paraphrase a quote.
Write the explanation for a book editor: describe what the passages share in plain language. Do NOT
mention similarity numbers, baselines, scores, or the category names above in your explanation.
Return JSON: {"verdicts":[{"index":0,"relationship":"...","confidence":"high|medium|low","explanation":"...","quoteA":"...","quoteB":"..."}]}`;

async function judgePairs(pairs: PassagePair[], base: number, trace?: Trace) {
  const body = pairs
    .map(
      (p, i) => `### Pair ${i}  (similarity ${p.similarity.toFixed(4)}, baseline ${base.toFixed(4)})
[A] ${p.a.bookTitle}, ${p.a.chapterTitle}
${p.a.text.slice(0, 1400)}

[B] ${p.b.bookTitle}, ${p.b.chapterTitle}
${p.b.text.slice(0, 1400)}`,
    )
    .join('\n\n');

  const { message } = await chat({
    messages: [
      { role: 'system', content: JUDGE_SYSTEM },
      { role: 'user', content: body },
    ],
    jsonMode: true,
    maxTokens: 2000,
    trace,
    label: 'llm:judge-similarity',
  });

  try {
    const parsed = JSON.parse(message.content ?? '{}');
    for (const v of parsed.verdicts ?? []) {
      const target = pairs[v.index];
      if (target) target.verdict = v;
    }
  } catch {
    // A malformed judge response degrades to scores-only rather than failing
    // the whole request. The similarity numbers are still useful on their own.
  }
}
