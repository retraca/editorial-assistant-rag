import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { getBm25 } from '../retrieval/hybrid.js';
import { runChat } from '../agent/chat.js';
import { auditClaims } from '../agent/claims.js';
import type { Chunk } from '../ingest/chunk.js';
import cases from './cases.json' with { type: 'json' };

/**
 * Recall of the output guardrails, measured by planting known defects.
 *
 * WHY THIS EXISTS. D-61 measured precision and declared success. D-64 found
 * recall was zero. Both numbers came from the same place: whichever answers the
 * groundedness judge happened to fail on a given run, which is **one or two
 * cases**. Across three runs after the D-64 fix the guardrail caught 1 of 3.
 * That is not a recall measurement, it is a coin toss with a denominator.
 *
 * The problem is structural. Real defects are rare, unlabelled, and appear in
 * different answers each run, so the only honest way to measure detection is to
 * introduce defects deliberately and count how many come back.
 *
 * Same idea as the needle test (D-28): plant something known, measure whether
 * the system finds it. Here the needle is a corruption rather than a fact.
 *
 * Each real answer becomes five variants:
 *
 *   control      unchanged. A flag here is a CANDIDATE false positive, and on the
 *                first real run all three turned out to be genuine defects in the
 *                original answers. Inspect before believing the number.
 *   negation     a negation dropped inside a quotation ("without" -> "with").
 *                The exact failure D-64 was built for.
 *   misquote     a content word swapped inside a quotation.
 *   fabrication  an extra sentence asserting an event no passage contains.
 *   number       a figure altered.
 *
 * Precision and recall then come from the same run, on the same answers, with a
 * denominator large enough to mean something.
 *
 * Capture once, then measure as often as you like:
 *   npm run eval:tamper -- --capture
 *   npm run eval:tamper
 *
 * See DECISIONS.md D-65.
 */

const BASE = path.join(config.paths.index, '..', 'eval', 'tamper-base.json');
const CAPTURE = process.argv.includes('--capture');

interface Captured {
  id: string;
  question: string;
  answer: string;
  passages: Chunk[];
}

type Kind = 'control' | 'negation' | 'misquote' | 'fabrication' | 'number';

/** Quoted spans, matched the same way the guardrail matches them. */
const quotedSpans = (answer: string): string[] => [
  ...[...answer.matchAll(/[“]([^”]{16,300})[”]/g)].map((m) => m[1]),
  ...[...answer.matchAll(/"([^"\s][^"]{14,298}[^"\s])"/g)].map((m) => m[1]),
];

/**
 * Returns the tampered answer, or null when this answer cannot carry this
 * corruption. A variant that could not be applied is skipped rather than
 * counted, because scoring an unmodified answer as a miss would understate
 * recall exactly as badly as the problem being fixed.
 */
function tamper(answer: string, kind: Kind, passages: Chunk[]): string | null {
  const spans = quotedSpans(answer);

  switch (kind) {
    case 'control':
      return answer;

    case 'negation': {
      // Only inside a quotation, and only where it reverses the sense.
      const span = spans.find((s) => /\bwithout\b|\bnever\b|\bnot\b|\bno one\b/i.test(s));
      if (!span) return null;
      const flipped = span
        .replace(/\bwithout\b/i, 'with')
        .replace(/\bnever\b/i, 'always')
        .replace(/\bno one\b/i, 'everyone')
        .replace(/\bnot\b/i, '');
      return answer.replace(span, flipped);
    }

    case 'misquote': {
      const span = spans.find((s) => s.split(' ').length >= 6);
      if (!span) return null;
      const words = span.split(' ');
      // Swap a word in the middle, away from the quotation's edges.
      const i = Math.floor(words.length / 2);
      words[i] = 'obviously';
      return answer.replace(span, words.join(' '));
    }

    case 'fabrication': {
      const id = passages[0]?.id;
      if (!id) return null;
      return `${answer}\n\nHe later sold the estate to a merchant from Bristol and moved abroad [${id}].`;
    }

    case 'number': {
      const m = answer.match(/\b(one|two|three|four|five|ten|thousand|\d[\d,]{2,})\b/);
      if (!m) return null;
      const swap: Record<string, string> = {
        one: 'seven', two: 'nine', three: 'eleven', four: 'twelve',
        five: 'fifteen', ten: 'sixty', thousand: 'million',
      };
      return answer.replace(m[0], swap[m[0].toLowerCase()] ?? '48,000');
    }
  }
}

async function capture() {
  const answerCases = (cases as any).cases.filter((c: any) => c.type === 'answer' && c.cites !== false);
  const out: Captured[] = [];
  console.log(`Capturing ${answerCases.length} real answers to tamper with\n`);
  for (const c of answerCases) {
    const r = await runChat([{ role: 'user', content: c.query }]);
    if (!r.citations.length) continue;
    out.push({ id: c.id, question: c.query, answer: r.answer, passages: r.citations });
    process.stdout.write(`\r  ${out.length}/${answerCases.length}`);
  }
  console.log();
  fs.mkdirSync(path.dirname(BASE), { recursive: true });
  fs.writeFileSync(BASE, JSON.stringify({ capturedAt: new Date().toISOString(), answers: out }, null, 2));
  console.log(`Wrote ${out.length} answers to ${BASE}`);
}

async function measure() {
  if (!fs.existsSync(BASE)) {
    console.error('No captured answers. Run with --capture first.');
    process.exit(1);
  }
  const { answers } = JSON.parse(fs.readFileSync(BASE, 'utf8')) as { answers: Captured[] };
  const kinds: Kind[] = ['control', 'negation', 'misquote', 'fabrication', 'number'];
  const tally: Record<string, { applied: number; flagged: number }> = {};
  for (const k of kinds) tally[k] = { applied: 0, flagged: 0 };

  console.log(`${answers.length} answers x ${kinds.length} variants\n`);

  for (const a of answers) {
    const line: string[] = [];
    for (const kind of kinds) {
      const text = tamper(a.answer, kind, a.passages);
      if (text === null) { line.push(`${kind}:skip`); continue; }
      const audit = await auditClaims(text, a.passages);
      tally[kind].applied++;
      if (!audit.ok) tally[kind].flagged++;
      line.push(`${kind}:${audit.ok ? '-' : 'FLAG'}`);
    }
    console.log(`  ${a.id.padEnd(18)} ${line.join('  ')}`);
  }

  console.log('\n--- detection by defect ---');
  for (const k of kinds) {
    const t = tally[k];
    if (!t.applied) { console.log(`${k.padEnd(12)} not applicable to any answer`); continue; }
    const pct = ((t.flagged / t.applied) * 100).toFixed(0);
    // A flag on an unmodified answer is a CANDIDATE false positive, never a
    // confirmed one. Every control flag in the first real run turned out to be a
    // genuine defect in the original answer: a paraphrase inside quotation
    // marks, a fabricated quotation, and the assistant quoting the comparison
    // machinery's own phrasing as if it came from the books. Inspect before
    // believing the number.
    const label = k === 'control' ? 'flagged on unmodified answers (inspect each)' : 'caught';
    console.log(`${k.padEnd(12)} ${t.flagged}/${t.applied}  ${pct}%  ${label}`);
  }

  const planted = kinds.filter((k) => k !== 'control');
  const applied = planted.reduce((n, k) => n + tally[k].applied, 0);
  const caught = planted.reduce((n, k) => n + tally[k].flagged, 0);
  console.log(`\noverall recall  ${caught}/${applied}  ${((caught / applied) * 100).toFixed(0)}%`);
  console.log(`flagged unmodified ${tally.control.flagged}/${tally.control.applied} (inspect: may be real defects)`);
}

async function main() {
  store.load();
  getBm25();
  await (CAPTURE ? capture() : measure());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
