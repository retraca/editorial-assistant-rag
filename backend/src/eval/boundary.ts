import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { retrieve, getBm25 } from '../retrieval/hybrid.js';
import { chat } from '../azure.js';
import { Trace } from '../trace.js';

/**
 * Does chunk overlap earn its cost?
 *
 * THE QUESTION NOTHING ELSE COULD ANSWER. D-56 swept overlap across three full
 * re-ingests and found the three settings indistinguishable on chapter recall,
 * with zero overlap scoring highest while producing the smallest index. That
 * measurement was reported honestly and then explicitly NOT acted on, because
 * chapter recall cannot see the thing overlap exists to prevent: an answer that
 * straddles a chunk boundary and gets cut in half. If the gold chapter is
 * retrieved either way, the metric scores a pass regardless.
 *
 * This builds the instrument that can see it.
 *
 * HOW IT WORKS.
 *   1. Find adjacent chunk pairs inside one chapter. The seam between them is a
 *      boundary that overlap is supposed to heal.
 *   2. Ask the model for a question whose answer needs BOTH sides of the seam,
 *      plus one distinctive term from each side.
 *   3. A case passes when the retrieved passages contain every required term.
 *
 * WHY REQUIRED TERMS RATHER THAN CHUNK IDS. Changing the overlap re-chunks the
 * corpus, so any gold expressed as a chunk id is invalidated by the very change
 * being measured. Terms survive re-chunking, which is the same reasoning that
 * shaped cases.json. Without this the comparison is not possible at all.
 *
 * Generate once against the ZERO-overlap index, where the seams are real:
 *   CHUNK_OVERLAP_WORDS=0 npm run ingest
 *   npm run eval:boundary -- --generate
 * Then measure any config against the saved set:
 *   npm run eval:boundary
 *
 * See DECISIONS.md D-60.
 */

const OUT = path.join(config.paths.index, '..', 'eval', 'cases-boundary.json');
const GENERATE = process.argv.includes('--generate');
const COUNT = Number(process.argv.find((a) => a.startsWith('--count='))?.split('=')[1] ?? 30);
const K = Number(process.argv.find((a) => a.startsWith('--k='))?.split('=')[1] ?? config.retrieval.k);

interface BoundaryCase {
  id: string;
  query: string;
  /** One distinctive term from each side of the seam. Both must be retrieved. */
  requireBefore: string;
  requireAfter: string;
  book: string;
  chapter: number;
}

const GEN_SYSTEM = `You are building a retrieval test from two CONSECUTIVE passages of a novel.

The passages are adjacent: the second continues directly from the first. Return JSON:
{"query": "...", "requireBefore": "...", "requireAfter": "...", "usable": true}

"query": a question a reader would actually ask, whose answer needs information from BOTH passages.
Not two questions joined by "and". One question that cannot be answered from either half alone,
because the setup is in the first and the outcome is in the second.

"requireBefore": a distinctive word or short phrase appearing ONLY in the first passage.
"requireAfter": a distinctive word or short phrase appearing ONLY in the second passage.

Both must be lowercase, two words at most, and must be terms whose presence proves that passage was
retrieved. Avoid common words. Avoid character names that appear throughout the book.

Set "usable": false if the two passages have no real continuity, for example if one is a chapter
heading, a list, or the seam falls between unrelated scenes. A weak case is worse than no case.`;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

async function generate() {
  const trace = new Trace();
  const cases: BoundaryCase[] = [];

  // Adjacent chunks within a chapter, spread across both books.
  const seams: [number, number][] = [];
  for (let i = 0; i < store.chunks.length - 1; i++) {
    const a = store.chunks[i];
    const b = store.chunks[i + 1];
    if (a.bookId === b.bookId && a.chapterIndex === b.chapterIndex) seams.push([i, i + 1]);
  }
  // Even spread rather than the first N, which would all come from chapter one.
  const step = Math.max(1, Math.floor(seams.length / (COUNT * 2)));
  const picked = seams.filter((_, i) => i % step === 0).slice(0, COUNT * 2);
  console.log(`${seams.length} in-chapter seams, sampling ${picked.length} to build ${COUNT} cases\n`);

  for (const [i, j] of picked) {
    if (cases.length >= COUNT) break;
    const a = store.chunks[i];
    const b = store.chunks[j];
    try {
      const { message } = await chat({
        messages: [
          { role: 'system', content: GEN_SYSTEM },
          { role: 'user', content: `FIRST PASSAGE:\n${a.text}\n\nSECOND PASSAGE:\n${b.text}` },
        ],
        jsonMode: true,
        maxTokens: 400,
        trace,
        label: `boundary:${a.id}`,
      });
      const p = JSON.parse(message.content ?? '{}');
      if (!p.usable || !p.query || !p.requireBefore || !p.requireAfter) continue;

      // The generator is not trusted about its own terms: verify each really
      // occurs on its own side and not on the other, or the case proves nothing.
      const before = norm(String(p.requireBefore));
      const after = norm(String(p.requireAfter));
      const inA = norm(a.text).includes(before) && !norm(a.text).includes(after);
      const inB = norm(b.text).includes(after) && !norm(b.text).includes(before);
      if (!inA || !inB) continue;

      cases.push({
        id: `bnd-${cases.length}`,
        query: String(p.query),
        requireBefore: before,
        requireAfter: after,
        book: a.bookId,
        chapter: a.chapterIndex,
      });
      process.stdout.write(`\r  ${cases.length}/${COUNT}`);
    } catch { /* a failed generation is a skipped case, not a failed run */ }
  }
  console.log();

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    note: 'Generated against a ZERO-overlap index, where every seam is a real cut. ' +
          'Expectations are terms, not chunk ids, so the set stays valid when the chunking changes.',
    generatedAt: new Date().toISOString(),
    cases,
  }, null, 2));
  const s = trace.summary();
  console.log(`Wrote ${cases.length} cases to ${OUT}  ($${s.estimatedCostUsd.toFixed(3)})`);
}

async function measure() {
  if (!fs.existsSync(OUT)) {
    console.error(`No case file. Run with --generate against a zero-overlap index first.`);
    process.exit(1);
  }
  const { cases } = JSON.parse(fs.readFileSync(OUT, 'utf8')) as { cases: BoundaryCase[] };
  console.log(`${cases.length} boundary cases, k=${K}, ${store.chunks.length} chunks in index\n`);

  let both = 0;
  let either = 0;
  const misses: string[] = [];

  for (const c of cases) {
    const hits = await retrieve({ query: c.query, bookId: c.book, k: K });
    const text = norm(hits.map((h) => h.chunk.text).join(' '));
    const hasBefore = text.includes(c.requireBefore);
    const hasAfter = text.includes(c.requireAfter);
    if (hasBefore && hasAfter) both++;
    else if (hasBefore || hasAfter) either++;
    if (!(hasBefore && hasAfter)) {
      misses.push(`${c.id} ${hasBefore ? 'lost after' : hasAfter ? 'lost before' : 'lost both'}: ${c.query.slice(0, 60)}`);
    }
  }

  const pct = (n: number) => `${((n / cases.length) * 100).toFixed(1)}%`;
  console.log(`  both sides retrieved   ${both}/${cases.length}  ${pct(both)}   <- the number that matters`);
  console.log(`  only one side          ${either}/${cases.length}  ${pct(either)}`);
  console.log(`  neither                ${cases.length - both - either}/${cases.length}`);
  if (misses.length && process.argv.includes('--show-misses')) {
    console.log('\n  misses:');
    misses.slice(0, 12).forEach((m) => console.log(`   - ${m}`));
  }
}

async function main() {
  store.load();
  getBm25();
  await (GENERATE ? generate() : measure());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
