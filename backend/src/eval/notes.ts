import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { chat } from '../azure.js';
import { Trace } from '../trace.js';

/**
 * Are the chapter notes actually faithful to the chapters?
 *
 * THE GAP THIS CLOSES. G1, "explore and understand a book", does not go through
 * retrieval at all: `about_the_book` reads the notes written at ingest, and the
 * assistant repeats them. So the entire quality of that goal rests on prose the
 * model wrote once, and **only the quotations inside it were ever verified**.
 * D-43 checks every key moment character by character against its chapter and
 * never checks a single sentence of the summary around it.
 *
 * That is a load-bearing assumption sitting under a quarter of the product. Four
 * answer-eval cases test that the assistant *uses* the notes; nothing tested
 * whether the notes are right.
 *
 * Method: sample chapters, show a judge the chapter and its note, ask which
 * statements in the note the chapter does not support. Same shape as the claim
 * audit (D-61), pointed at the ingest output rather than at an answer.
 *
 * Run: npm run eval:notes [-- --sample=20]
 *
 * See DECISIONS.md D-73.
 */

const SAMPLE = Number(process.argv.find((a) => a.startsWith('--sample='))?.split('=')[1] ?? 16);

const SYSTEM = `You are checking a chapter summary against the chapter it describes.

Return JSON: {"unsupported": ["...", "..."], "verdict": "faithful" | "drifts"}

List any statement in the summary that the chapter does not support: an event that does not happen,
a motive not shown, a name or relationship that is wrong, an outcome reversed.

ALLOW compression, paraphrase, ordering and reasonable inference from what is shown. A summary is
supposed to be shorter than the chapter; only flag things that are WRONG, not things that are absent
for brevity.

"verdict" is "drifts" if you listed anything, otherwise "faithful".`;

async function main() {
  store.load();
  const file = path.join(config.paths.index, '..', 'summaries.json');
  const notes = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trace = new Trace();

  // Spread across both books and across each book's length, so the sample is
  // not all opening chapters where the prose is easiest.
  const all: { book: string; index: number; title: string; summary: string }[] = [];
  for (const [bookId, b] of Object.entries<any>(notes.books)) {
    for (const c of b.chapters) all.push({ book: bookId, index: c.index, title: c.title, summary: c.summary });
  }
  const step = Math.max(1, Math.floor(all.length / SAMPLE));
  const picked = all.filter((_, i) => i % step === 0).slice(0, SAMPLE);

  console.log(`Checking ${picked.length} of ${all.length} chapter notes\n`);
  let drifts = 0;
  const problems: string[] = [];

  for (const c of picked) {
    const text = store.chapterText(c.book, c.index);
    if (!text || !c.summary) continue;
    try {
      const { message } = await chat({
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `CHAPTER: ${c.title}\n\n${text.slice(0, 14000)}\n\n---\n\nSUMMARY:\n${c.summary}` },
        ],
        jsonMode: true,
        maxTokens: 500,
        trace,
        label: `notes:${c.book}:${c.index}`,
      });
      const v = JSON.parse(message.content ?? '{}');
      const bad = (v.unsupported ?? []).map((x: unknown) => String(x));
      const ok = v.verdict !== 'drifts' && bad.length === 0;
      if (!ok) {
        drifts++;
        problems.push(`${c.book} ${c.title}: ${bad[0] ?? 'unspecified'}`);
      }
      console.log(`  ${ok ? 'ok  ' : 'DRIFT'} ${c.book.slice(0, 12).padEnd(12)} ${c.title.slice(0, 34)}`);
    } catch (err) {
      console.log(`  skip  ${c.title.slice(0, 34)} (${(err as Error).message.slice(0, 40)})`);
    }
  }

  const n = picked.length;
  console.log(`\nfaithful ${n - drifts}/${n}  (${(((n - drifts) / n) * 100).toFixed(0)}%)`);
  if (problems.length) {
    console.log('\nwhat drifted:');
    problems.slice(0, 8).forEach((p) => console.log(`  - ${p}`));
  }
  console.log(`\ncost $${trace.summary().estimatedCostUsd.toFixed(3)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
