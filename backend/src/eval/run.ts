import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { retrieve, getBm25 } from '../retrieval/hybrid.js';
import { broadSearch } from '../retrieval/broaden.js';
import { runChat } from '../agent/chat.js';
import { chat } from '../azure.js';
import cases from './cases.json' with { type: 'json' };

/**
 * Eval harness.
 *
 * Three things are measured, because they fail independently:
 *
 *   retrieval, is the right passage in the top k at all? If it is not, no
 *                amount of prompt work fixes the answer.
 *   grounding, does the answer's every claim follow from the passages cited,
 *                and do those citation ids actually exist? Judged by the model,
 *                which is imperfect but catches the obvious failures.
 *   refusal, when the corpus cannot answer, does the assistant say so? The
 *                most damaging failure for an editorial tool is a confident,
 *                fluent, unsupported answer.
 *
 * Run with `npm run eval`. Use `--retrieval-only` to skip the LLM stages, which
 * is the fast loop when tuning chunking or k. See DECISIONS.md D-14.
 */

const RETRIEVAL_ONLY = process.argv.includes('--retrieval-only');
/** `--only=g1` runs just the cases whose id starts with that, for iterating on one. */
const ONLY = process.argv.find((a) => a.startsWith('--only='))?.split('=')[1];
const K = Number(process.env.EVAL_K ?? config.retrieval.k);
const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'hybrid') as
  | 'hybrid'
  | 'dense'
  | 'sparse';

interface Row {
  id: string;
  type: string;
  /** Which of the four use cases this case defends. See cases.json. */
  goal?: string;
  /** Claim-audit outcome, for measuring the guardrail against the judge. */
  claims?: { checked: number; flagged: number; inferred: number };
  pass: boolean;
  detail: string;
  ms: number;
  rank?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'");

async function evalRetrieval(c: any): Promise<Row> {
  const t0 = Date.now();
  const hits = await retrieve({ query: c.query, k: K, mode: MODE });
  const rankOfBook = hits.findIndex((h) => h.chunk.bookId === c.book);
  const matchRank = hits.findIndex(
    (h) => h.chunk.bookId === c.book && c.anyOf.some((t: string) => norm(h.chunk.text).includes(norm(t))),
  );
  return {
    id: c.id,
    type: 'retrieval',
    goal: c.goal,
    pass: matchRank >= 0,
    rank: matchRank >= 0 ? matchRank + 1 : undefined,
    detail:
      matchRank >= 0
        ? `hit@${matchRank + 1}`
        : `MISS (correct book first seen at rank ${rankOfBook >= 0 ? rankOfBook + 1 : '-'})`,
    ms: Date.now() - t0,
  };
}

const GROUND_SYSTEM = `You audit an assistant's answer against the passages it was given.
Return JSON: {"grounded": true|false, "unsupported": ["claim", ...], "reason": "..."}

"grounded" is false if ANY factual claim about the books is absent from the passages, even if the
claim is true of the real novel. The test is support by the supplied text, not correctness in general.
Ignore hedging, structure and style. Judge only factual support.`;

/**
 * Topical coverage. NOT recall@k. An abstract subject has no single gold
 * passage, which is why the retrieval set could never measure this (D-53). What
 * it asserts is the property the topic search exists to provide: a subject only
 * one book names out loud must still reach both.
 */
async function evalTopic(c: any): Promise<Row> {
  const t0 = Date.now();
  const { phrases, hits } = await broadSearch({ query: c.query, k: 5 });
  const found = new Set(hits.map((h) => h.chunk.bookId));
  const missing = (c.requireBooks ?? []).filter((b: string) => !found.has(b));
  return {
    id: c.id, type: c.type, goal: c.goal, pass: missing.length === 0, ms: Date.now() - t0,
    detail: missing.length
      ? `no passage from ${missing.join(', ')} (searched ${phrases.length + 1} ways)`
      : `${found.size} books covered via ${phrases.length + 1} searches`,
  };
}

async function evalAnswer(c: any): Promise<Row> {
  const t0 = Date.now();
  // The shape of the answer follows from the question now, so a case exercises
  // the per-book path by asking for it in words rather than by setting a flag.
  const result = await runChat([{ role: 'user', content: c.query }]);
  const answer = result.answer ?? '';

  // Citation integrity: every [id] in the answer must resolve to a real chunk.
  const cited = [...answer.matchAll(/\[([a-z_]+:\d+:\d+)\]/g)].map((m) => m[1]);
  const bogus = cited.filter((id) => !store.get(id));

  const mentions = (c.mustMention ?? []).every((t: string) => norm(answer).includes(norm(t)));
  // Terms that must NOT appear. This is how the "never show the reader a number
  // they cannot act on" rule (D-33) becomes a test rather than a good intention.
  const leaked = (c.mustNotMention ?? []).filter((t: string) => norm(answer).includes(norm(t)));

  const passages = result.citations.map((c2) => `[${c2.id}] ${c2.text}`).join('\n\n---\n\n');
  // The judge sees everything the assistant saw, tool results included. Judging
  // against passages alone flagged a correctly-reported similarity score as a
  // hallucination, because that number comes from the retrieval system rather
  // than from any book.
  const toolEvidence = result.toolOutputs.join('\n\n===\n\n');
  // Majority of three. A single LLM judgement swung this metric 1/3-3/3 on
  // identical code, which made it useless for deciding anything. Voting cuts
  // that variance at 3x the judge cost. The judge is the cheap half of the
  // case, so the trade is worth it.
  const votes = await Promise.all(
    [0, 1, 2].map(async () => {
      const { message: m } = await chat({
        messages: [
          { role: 'system', content: GROUND_SYSTEM },
          {
            role: 'user',
            content:
              `PASSAGES:\n${passages}\n\nSYSTEM OUTPUTS AVAILABLE TO THE ASSISTANT:\n${toolEvidence}\n\nANSWER:\n${answer}`,
          },
        ],
        jsonMode: true,
        maxTokens: 700,
      });
      try {
        const v = JSON.parse(m.content ?? '{}');
        return { ok: Boolean(v.grounded), reason: String(v.reason ?? '') };
      } catch {
        return { ok: false, reason: 'judge unparseable' };
      }
    }),
  );
  const yes = votes.filter((v) => v.ok).length;
  const grounded = yes >= 2;
  const reason = grounded ? '' : (votes.find((v) => !v.ok)?.reason ?? '');
  const split = `${yes}/3`;

  // Most answers must cite. A question answered from collection facts, how many
  // books, how many chapters, has no passage behind it, and requiring one there
  // is how a model learns to invent citations. Opt out per case, never globally.
  const needsCite = c.cites !== false;
  // A misquotation fails the case. It is the one defect here decided by string
  // comparison rather than judgement: the quoted text is either in a retrieved
  // passage or it is not. The suite was blind to this and three answers carrying
  // verified-absent quotations were passing. See D-64 and D-66.
  const misquoted = result.claims.misquoted;
  const pass = grounded && bogus.length === 0 && mentions && !leaked.length
    && !misquoted.length && (!needsCite || cited.length > 0);
  return {
    id: c.id,
    type: 'answer',
    goal: c.goal,
    claims: {
      checked: result.claims.checked,
      flagged: result.claims.unsupported.length,
      inferred: result.claims.inferences.length,
    },
    pass,
    detail:
      `cites=${cited.length} bogus=${bogus.length} grounded=${grounded}(${split}) keywords=${mentions}` +
      // The claim audit is measured against the judge, not trusted: a flag on an
      // answer the judge passes is a false positive, and false positives are what
      // decide whether a guardrail is worth having (D-61).
      (misquoted.length ? ` MISQUOTED=${misquoted.length}` : '') +
      ` claims=${result.claims.checked} unsupported=${result.claims.unsupported.length}` +
      ` inferred=${result.claims.inferences.length} recovered=${result.claims.recovered.length}` +
      (leaked.length ? ` LEAKED=${leaked.join(',')}` : '') +
      // The full judge reason is kept: a failure you cannot diagnose from the
      // report costs a whole re-run to understand.
      (pass ? '' : ` :: ${misquoted.length ? `not in any passage: "${misquoted[0].slice(0, 70)}" ` : ''}${reason}`),
    ms: Date.now() - t0,
  };
}

/**
 * Refusal is judged by a model, not by keyword matching.
 *
 * The first version matched a list of phrases ("cannot", "no information", …).
 * It scored a textbook refusal, "I can only answer questions about the books in
 * this collection", as a FAILURE, because that wording contains none of the
 * markers. A brittle checker that reports false failures is worse than no
 * checker: it trains you to ignore the eval.
 */
const REFUSAL_SYSTEM = `Decide whether an assistant DECLINED to answer or ANSWERED the question.
It counts as declining if it says the question is out of scope, or that it can only address the
books in its collection, however phrased. It counts as answering if it supplies the requested
information from outside the collection.
Return JSON: {"declined": true|false, "reason": "..."}`;

async function evalRefusal(c: any): Promise<Row> {
  const t0 = Date.now();
  // The shape of the answer follows from the question now, so a case exercises
  // the per-book path by asking for it in words rather than by setting a flag.
  const result = await runChat([{ role: 'user', content: c.query }]);
  const answer = result.answer ?? '';

  const { message } = await chat({
    messages: [
      { role: 'system', content: REFUSAL_SYSTEM },
      { role: 'user', content: `QUESTION:\n${c.query}\n\nASSISTANT REPLY:\n${answer}` },
    ],
    jsonMode: true,
    maxTokens: 300,
  });
  let declined = false;
  let reason = 'judge unparseable';
  try {
    const v = JSON.parse(message.content ?? '{}');
    declined = Boolean(v.declined);
    reason = v.reason ?? '';
  } catch {
    /* leave defaults */
  }

  return {
    id: c.id,
    type: 'refusal',
    goal: c.goal,
    pass: declined,
    detail: declined ? 'declined as expected' : `ANSWERED ANYWAY :: ${answer.slice(0, 160)} :: ${reason}`,
    ms: Date.now() - t0,
  };
}

async function main() {
  store.load();
  getBm25();

  const selected = (cases.cases as any[])
    .filter((c) => !RETRIEVAL_ONLY || c.type === 'retrieval')
    .filter((c) => !ONLY || c.id.startsWith(ONLY));
  console.log(
    `Running ${selected.length} cases (k=${K}, mode=${MODE})${RETRIEVAL_ONLY ? ' [retrieval only]' : ''}\n`,
  );

  const rows: Row[] = [];
  for (const c of selected) {
    const row =
      c.type === 'retrieval'
        ? await evalRetrieval(c)
        : c.type === 'topic'
          ? await evalTopic(c)
          : c.type === 'answer'
            ? await evalAnswer(c)
            : await evalRefusal(c);
    rows.push(row);
    console.log(
      `${row.pass ? 'PASS' : 'FAIL'}  ${row.id.padEnd(16)} ${row.type.padEnd(10)} ` +
        `${String(row.ms).padStart(6)}ms  ${row.detail}`,
    );
  }

  const by = (t: string) => rows.filter((r) => r.type === t);
  const rate = (rs: Row[]) => (rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : 'n/a');

  // Pass rate on the retrieval half saturates at 24/24, so it detects breakage but not
  // degradation. MRR keeps moving after the binary metric has maxed out, which
  // is what makes tuning chunk size or k observable at all.
  // Claim-audit precision, measured against the groundedness judge.
  const answered = rows.filter((r) => r.type === 'answer' && r.claims);
  if (answered.length) {
    const flaggedOnPass = answered.filter((r) => r.pass && r.claims!.flagged > 0).length;
    const flaggedOnFail = answered.filter((r) => !r.pass && r.claims!.flagged > 0).length;
    const failed = answered.filter((r) => !r.pass).length;
    const totalClaims = answered.reduce((n, r) => n + r.claims!.checked, 0);
    const totalFlags = answered.reduce((n, r) => n + r.claims!.flagged, 0);
    const totalInferred = answered.reduce((n, r) => n + r.claims!.inferred, 0);
    console.log('\n--- claim audit (D-61) ---');
    console.log(`checked ${totalClaims} claims`);
    console.log(`  ${totalFlags} unsupported by the books (a defect)`);
    console.log(`  ${totalInferred} the assistant's own reading (marked, not an error, D-63)`);
    console.log(`fired on ${flaggedOnPass}/${answered.length - failed} answers the judge passed  (false positives)`);
    console.log(`fired on ${flaggedOnFail}/${failed} answers the judge failed  (catches)`);
  }

  const ret = by('retrieval');
  const mrr = ret.length
    ? ret.reduce((sum, r) => sum + (r.rank ? 1 / r.rank : 0), 0) / ret.length
    : 0;

  console.log('\n--- by mechanism ---');
  console.log(`retrieval  ${rate(ret)}   MRR ${mrr.toFixed(4)}   (mode=${MODE}, k=${K})`);
  console.log(`topic      ${rate(by('topic'))}`);
  console.log(`answer     ${rate(by('answer'))}`);
  console.log(`refusal    ${rate(by('refusal'))}`);

  // The mechanism view says which part broke; this one says which USE CASE is
  // unguarded. They are different questions, and only the second is the user's.
  const GOALS: [string, string][] = [
    ['G1', 'explore and understand a book'],
    ['G2', 'answer about specific parts'],
    ['G3', 'find relevant passages'],
    ['G4', 'compare across books'],
    ['guard', 'refuse what is out of scope'],
  ];
  console.log('\n--- by use case ---');
  for (const [g, label] of GOALS) {
    const rs = rows.filter((r) => r.goal === g);
    if (rs.length) console.log(`${g.padEnd(6)} ${rate(rs).padEnd(7)} ${label}`);
  }
  console.log(`\noverall    ${rate(rows)}`);

  const outDir = path.join(config.paths.index, '..', 'eval');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'last-run.json');
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), k: K, rows }, null, 2));
  console.log(`\nWrote ${out}`);

  if (rows.some((r) => !r.pass)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
