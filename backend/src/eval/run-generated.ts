import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { retrieve, getBm25 } from '../retrieval/hybrid.js';
import { rerank } from '../retrieval/rerank.js';
import { Trace } from '../trace.js';

/**
 * Runs the generated hard set. Reports two metrics:
 *
 *   strict. The exact gold chunk. Discriminating, and the one to tune on.
 *   chapter, any chunk from the gold chapter. More forgiving, and often the
 *             honest measure: with 60-word overlaps a neighbouring chunk
 *             frequently does answer the question.
 *
 * Usage:
 *   npm run eval:hard -- --mode=hybrid|dense|sparse [--k=8] [--rerank]
 */

const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;

/**
 * Bootstrap 95% CI. Resample the per-case results with replacement, recompute
 * the mean, take the 2.5th and 97.5th percentiles.
 *
 * This exists because n=60 with a 3-point difference is two cases. Without an
 * interval, "86.7% vs 83.3%" reads as a result when it may be noise. Two configs
 * whose intervals overlap are not distinguishable on this set, say so instead
 * of ranking them.
 *
 * Deterministic LCG rather than Math.random so runs are reproducible.
 */
function bootstrapCI(values: number[], iterations = 5000): [number, number] {
  if (!values.length) return [0, 0];
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(rnd() * values.length)];
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(iterations * 0.025)], means[Math.floor(iterations * 0.975)]];
}

const MODE = arg('mode', 'hybrid') as 'hybrid' | 'dense' | 'sparse';
const FILE = arg('file', 'cases-generated.json');
const SAVE = arg('save', '');
const K = Number(arg('k', String(config.retrieval.k)));
const RERANK = process.argv.includes('--rerank');
// Rerank needs candidates to reorder, so it over-fetches then cuts back to K.
const FETCH = RERANK ? Math.max(K * 3, 24) : K;

async function main() {
  store.load();
  getBm25();

  const file = path.join(path.dirname(new URL(import.meta.url).pathname), FILE);
  if (!fs.existsSync(file)) {
    throw new Error(`No cases at ${FILE}. Run \`npm run eval:generate\` first.`);
  }
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));

  const trace = new Trace();
  // Per-case values, kept so the CI can resample them.
  const strictHit: number[] = [];
  const chapterHit: number[] = [];
  const strictRRs: number[] = [];
  const chapterRRs: number[] = [];
  const misses: string[] = [];

  for (const c of cases) {
    let hits = await retrieve({ query: c.query, k: FETCH, mode: MODE });
    if (RERANK) hits = (await rerank(c.query, hits, K, trace)) as typeof hits;

    const sIdx = hits.findIndex((h) => h.chunk.id === c.goldChunkId);
    const cIdx = hits.findIndex(
      (h) => h.chunk.bookId === c.goldBook && h.chunk.chapterIndex === c.goldChapter,
    );
    strictHit.push(sIdx >= 0 ? 1 : 0);
    strictRRs.push(sIdx >= 0 ? 1 / (sIdx + 1) : 0);
    chapterHit.push(cIdx >= 0 ? 1 : 0);
    chapterRRs.push(cIdx >= 0 ? 1 / (cIdx + 1) : 0);
    if (cIdx < 0) misses.push(`${c.id}: ${c.query.slice(0, 78)}`);
  }

  const n = cases.length;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const pct = (v: number[]) => {
    const [lo, hi] = bootstrapCI(v);
    return `${(mean(v) * 100).toFixed(1)}% [${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}]`;
  };
  const num = (v: number[]) => {
    const [lo, hi] = bootstrapCI(v);
    return `${mean(v).toFixed(4)} [${lo.toFixed(4)}-${hi.toFixed(4)}]`;
  };

  // recall@k first, deliberately. LLMs show U-shaped attention over long
  // contexts, so rank order within the retrieved set matters far less than
  // whether the evidence is in the set at all. MRR is a ranked-search-UI metric;
  // for a RAG pipeline recall is the one that predicts answer quality.
  console.log(
    `${FILE}  mode=${MODE.padEnd(6)} k=${K} rerank=${RERANK ? 'on ' : 'off'}  n=${n}   (95% CI)\n` +
      `  strict   recall@${K} ${pct(strictHit)}    MRR ${num(strictRRs)}\n` +
      `  chapter  recall@${K} ${pct(chapterHit)}    MRR ${num(chapterRRs)}`,
  );
  if (RERANK) {
    const s = trace.summary();
    console.log(`  rerank cost $${s.estimatedCostUsd.toFixed(4)}  ${(s.totalMs / 1000).toFixed(0)}s total`);
  }
  if (SAVE) {
    // Per-case results, so two configurations can be compared with a PAIRED
    // test. Comparing marginal confidence intervals is the wrong instrument for
    // two systems run on the same queries: it ignores that they succeed and fail
    // on the same items, and is far too conservative.
    fs.writeFileSync(
      path.join(path.dirname(new URL(import.meta.url).pathname), SAVE),
      JSON.stringify({
        file: FILE, mode: MODE, k: K, rerank: RERANK,
        ids: cases.map((c: any) => c.id),
        strictHit, chapterHit, strictRR: strictRRs, chapterRR: chapterRRs,
      }),
    );
    console.log(`  saved per-case results -> ${SAVE}`);
  }
  if (misses.length && process.argv.includes('--show-misses')) {
    console.log(`\n  chapter-level misses (${misses.length}):`);
    misses.slice(0, 12).forEach((m) => console.log(`   - ${m}`));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
