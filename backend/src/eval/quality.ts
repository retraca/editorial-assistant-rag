import fs from 'node:fs';
import path from 'node:path';
import { store } from '../retrieval/store.js';
import { retrieve, getBm25 } from '../retrieval/hybrid.js';
import { rerank } from '../retrieval/rerank.js';
import { chat, embed, dot } from '../azure.js';
import { runChat } from '../agent/chat.js';
import { Trace } from '../trace.js';

/**
 * The two axes the rest of the suite does not measure.
 *
 * Everything else here asks whether the evidence was found (recall@k, MRR) and
 * whether the answer is faithful to it (the groundedness judge, the claim audit,
 * the quotation check, the tamper set). Five instruments on one axis. Neither of
 * these was measured, and both are defaults in Ragas, which is how the gap was
 * found. See D-87.
 *
 *   context precision   of the K passages handed to the model, how many were
 *                       actually relevant? Recall says the right passage was in
 *                       the set. It says nothing about the seven others.
 *
 *   answer relevance    does the answer address the question that was asked? A
 *                       fully cited, fully supported, evasive answer passes
 *                       every other check in this suite.
 *
 * WHY THIS IS WORTH THE MONEY, beyond filling a gap: D-55 concluded that k
 * cannot be chosen on quality and had to be chosen on context cost, because the
 * answer judge could not resolve a two-case difference between k=4 and k=8.
 * Context precision measures the cost of a larger k directly, in irrelevant
 * passages per question, which is the quality signal that decision lacked.
 *
 * Both metrics are model-judged and therefore noisy. Both are reported with a
 * bootstrap interval, and answer relevance is reported against a baseline,
 * because a cosine between two questions about the same two novels is high
 * before anyone does anything (the same reason raw similarity is never shown
 * alone, D-33).
 *
 * Run: npm run eval:quality [-- --k=4,8,12] [--sample=30] [--only=context|relevance]
 */

const arg = (name: string, dflt: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? dflt;

const KS = arg('k', '4,8,12').split(',').map(Number);
const SAMPLE = Number(arg('sample', '30'));
const ONLY = arg('only', 'both');
const RERANK = !process.argv.includes('--no-rerank');

/** Deterministic bootstrap, same shape as run-generated.ts so numbers compare. */
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

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
const pct = (v: number[]) => {
  const [lo, hi] = bootstrapCI(v);
  return `${(mean(v) * 100).toFixed(1)}% [${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}]`;
};
const num = (v: number[]) => {
  const [lo, hi] = bootstrapCI(v);
  return `${mean(v).toFixed(4)} [${lo.toFixed(4)}-${hi.toFixed(4)}]`;
};

/** Small worker pool. The sandbox 429s under load, so this is deliberately low. */
async function pool<T, R>(items: T[], width: number, fn: (item: T, i: number) => Promise<R>) {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(width, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i);
    }),
  );
  return out;
}

const RELEVANCE_SYSTEM = `You are judging whether each retrieved passage is USEFUL for answering a question about a novel.

Return JSON: {"relevant": [true, false, ...]} with exactly one boolean per passage, in order.

A passage is relevant if it contains information a person would actually use to answer the question:
the event, the character, the exchange, the description asked about.

A passage is NOT relevant if it merely comes from the same book, mentions the same character in an
unrelated moment, or is topically adjacent without bearing on the question. Being from the right
chapter is not enough.

Judge each passage on its own. Do not assume a passage is relevant because it was retrieved.`;

/**
 * Context precision.
 *
 * Two numbers, because they answer different questions:
 *
 *   precision@k          the fraction of the returned passages that were useful.
 *                        This is the number that tells you what a larger k costs.
 *   rank-weighted        Ragas' formulation: mean of precision@i over the ranks
 *                        where a relevant passage appears. Rewards putting the
 *                        useful passages first, which is what matters when the
 *                        model reads top-down.
 */
async function contextPrecision(trace: Trace) {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'cases-generated.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const step = Math.max(1, Math.floor(cases.length / SAMPLE));
  const picked = cases.filter((_: unknown, i: number) => i % step === 0).slice(0, SAMPLE);

  console.log(`\n=== context precision ===`);
  console.log(`${picked.length} of ${cases.length} generated cases, rerank ${RERANK ? 'on' : 'off'}\n`);
  console.log(`  k    precision@k                  rank-weighted                irrelevant/question`);

  const rows: { k: number; plain: number[]; weighted: number[] }[] = [];

  for (const k of KS) {
    const fetchN = RERANK ? Math.max(k * 3, 24) : k;
    const plain: number[] = [];
    const weighted: number[] = [];

    await pool(picked, 4, async (c: any) => {
      let hits = await retrieve({ query: c.query, k: fetchN });
      if (RERANK) hits = (await rerank(c.query, hits, k, trace)) as typeof hits;
      hits = hits.slice(0, k);
      if (!hits.length) return;

      const passages = hits
        .map((h, i) => `[${i + 1}] ${h.chunk.text.replace(/\s+/g, ' ').slice(0, 600)}`)
        .join('\n\n');
      try {
        const { message } = await chat({
          messages: [
            { role: 'system', content: RELEVANCE_SYSTEM },
            { role: 'user', content: `QUESTION: ${c.query}\n\nPASSAGES:\n${passages}` },
          ],
          jsonMode: true,
          maxTokens: 300,
          trace,
          label: `ctxprec:k${k}`,
        });
        const rel: boolean[] = (JSON.parse(message.content ?? '{}').relevant ?? []).map(Boolean);
        if (rel.length !== hits.length) return; // malformed, drop rather than guess
        const relCount = rel.filter(Boolean).length;
        plain.push(relCount / hits.length);
        // Ragas: mean of precision@i taken at the ranks where a relevant item sits.
        let seen = 0;
        const at: number[] = [];
        rel.forEach((r, i) => {
          if (r) { seen++; at.push(seen / (i + 1)); }
        });
        weighted.push(at.length ? mean(at) : 0);
      } catch {
        /* a judge failure is not a data point */
      }
    });

    rows.push({ k, plain, weighted });
    const irrelevant = (1 - mean(plain)) * k;
    console.log(
      `  ${String(k).padEnd(4)} ${pct(plain).padEnd(28)} ${pct(weighted).padEnd(28)} ${irrelevant.toFixed(1)}`,
    );
  }
  return rows;
}

const GEN_Q_SYSTEM = `Read an answer and write the question it actually answers.

Return JSON: {"questions": ["...", "...", "..."], "noncommittal": true|false}

Write exactly three questions, each one a question this answer genuinely and specifically answers.
Do not write questions the answer merely touches on.

Set "noncommittal" to true if the answer evades: if it declines, says it cannot find the information,
or answers something adjacent to what was clearly asked, rather than committing to an answer.`;

/**
 * Answer relevance, by Ragas' construction: ask a model what question the answer
 * answers, embed those questions and the real one, and take the mean cosine.
 * A high score means the answer is ABOUT the question. It says nothing about
 * whether the answer is true, which the rest of the suite already covers.
 *
 * THE BASELINE MATTERS MORE THAN THE SCORE. Two questions about the same two
 * 19th-century novels are close in embedding space before anyone does anything,
 * exactly as two random passages already score 0.4316 (D-33). So every answer is
 * also scored against the questions generated from a DIFFERENT answer. The gap
 * between the two is the signal; the raw cosine is not.
 */
async function answerRelevance(trace: Trace) {
  const file = path.join(path.dirname(new URL(import.meta.url).pathname), 'cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const answerCases = cases.filter((c: any) => c.type === 'answer');

  console.log(`\n=== answer relevance ===`);
  console.log(`${answerCases.length} answer cases, live through the full agent\n`);

  const rows = await pool(answerCases, 2, async (c: any) => {
    try {
      const res: any = await runChat([{ role: 'user', content: c.query }], undefined, c.books);
      const answer = String(res.answer ?? '');
      if (!answer) return null;
      const { message } = await chat({
        messages: [
          { role: 'system', content: GEN_Q_SYSTEM },
          { role: 'user', content: answer.slice(0, 6000) },
        ],
        jsonMode: true,
        maxTokens: 400,
        trace,
        label: `relevance:${c.id}`,
      });
      const parsed = JSON.parse(message.content ?? '{}');
      const qs: string[] = (parsed.questions ?? []).map(String).filter(Boolean).slice(0, 3);
      if (!qs.length) return null;
      return { id: c.id, query: c.query, qs, noncommittal: Boolean(parsed.noncommittal) };
    } catch {
      return null;
    }
  });

  const ok = rows.filter(Boolean) as NonNullable<(typeof rows)[number]>[];
  if (!ok.length) {
    console.log('  no usable answers');
    return { scores: [] as number[], baseline: [] as number[] };
  }

  // One embedding call for every question, real and generated.
  const originals = await embed(ok.map((r) => r.query), trace, 'relevance:q');
  const flat = ok.flatMap((r) => r.qs);
  const generated = await embed(flat, trace, 'relevance:gen');

  const scores: number[] = [];
  const baseline: number[] = [];
  let cursor = 0;
  const spans = ok.map((r) => {
    const s = cursor;
    cursor += r.qs.length;
    return [s, cursor] as const;
  });

  ok.forEach((r, i) => {
    const [s, e] = spans[i];
    const own = generated.slice(s, e);
    scores.push(mean(own.map((g) => dot(originals[i], g))));
    // Baseline: the same question against another answer's generated questions.
    const j = (i + 1) % ok.length;
    const [s2, e2] = spans[j];
    baseline.push(mean(generated.slice(s2, e2).map((g) => dot(originals[i], g))));
  });

  const noncommittal = ok.filter((r) => r.noncommittal);
  console.log(`  relevance   ${num(scores)}`);
  console.log(`  baseline    ${num(baseline)}   (this question vs a different answer)`);
  console.log(`  separation  ${(mean(scores) - mean(baseline)).toFixed(4)}`);
  console.log(`  noncommittal ${noncommittal.length}/${ok.length}`);
  if (noncommittal.length) noncommittal.forEach((r) => console.log(`     - ${r.id}: ${r.query.slice(0, 66)}`));

  const worst = ok
    .map((r, i) => ({ id: r.id, q: r.query, s: scores[i], b: baseline[i] }))
    .sort((a, b) => a.s - a.b - (b.s - b.b))
    .slice(0, 3);
  console.log(`\n  least on-topic, by separation from baseline:`);
  worst.forEach((w) => console.log(`     ${(w.s - w.b).toFixed(3)}  ${w.id}  ${w.q.slice(0, 60)}`));

  return { scores, baseline };
}

async function main() {
  store.load();
  getBm25();
  const trace = new Trace();

  if (ONLY !== 'relevance') await contextPrecision(trace);
  if (ONLY !== 'context') await answerRelevance(trace);

  const s = trace.summary();
  console.log(`\ncost $${s.estimatedCostUsd.toFixed(3)}  ${(s.totalMs / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
