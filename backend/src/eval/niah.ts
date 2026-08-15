import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { retrieve, getBm25 } from '../retrieval/hybrid.js';
import { rerank } from '../retrieval/rerank.js';
import { runChat } from '../agent/chat.js';
import { embed } from '../azure.js';
import { Trace } from '../trace.js';
import type { Chunk } from '../ingest/chunk.js';

/**
 * Needle-in-a-haystack, adapted for retrieval rather than long context.
 *
 * The classic test (Kamradt 2023) plants a fact in a long *context window* and
 * asks whether the model can find it. That measures a long-context LLM. This
 * system is RAG: the haystack is the 1,330-chunk corpus, not the prompt. So the
 * needle is planted in the **corpus** and the question is whether retrieval
 * surfaces it at all.
 *
 * Three design choices, each fixing a known weakness of naive NIAH:
 *
 * 1. **Two question forms per needle.** `literal` reuses the needle's wording;
 *    `latent` shares almost none and requires an associative hop
 *    ("snuff-box" -> "tobacco container"). This follows NoLiMa (ICML 2025):
 *    with literal overlap, BM25 finds the needle every time and the test
 *    measures string matching. The gap between the two forms is the real signal.
 *
 * 2. **Period-appropriate prose.** A modern or awkwardly-phrased needle is
 *    trivially separable in embedding space, and the test would be measuring
 *    style-anomaly detection instead of retrieval.
 *
 * 3. **Distractors.** Near-duplicate passages with the wrong details, planted in
 *    the *other* book, test precision rather than recall, whether the system
 *    returns the right needle, not merely a similar-looking one.
 *
 * Measured at three levels, because they fail independently:
 *   retrieved, is the needle chunk in the top k?
 *   answered, does the final answer contain the fact?
 *   cited, does the answer cite the needle chunk?
 *
 * Needles are appended to the store **in memory only**. The on-disk index is
 * never touched, so no rebuild is needed and nothing leaks into normal use.
 *
 * Known limitation, stated because it is the standard criticism of NIAH: a
 * clean result proves single-fact location, not reasoning over the corpus or
 * combining scattered facts. See DECISIONS.md D-28.
 *
 * Run: npm run eval:niah [-- --no-answer]
 */

const SKIP_ANSWER = process.argv.includes('--no-answer');
const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1] ?? 'hybrid') as
  'hybrid' | 'dense' | 'sparse';
const NO_RERANK = process.argv.includes('--no-rerank');
const K = Number(process.argv.find((a) => a.startsWith('--k='))?.split('=')[1] ?? config.retrieval.k);

interface Needle {
  id: string; book: string; depth: string; text: string;
  literal: string; latent: string;
  /** Per-form, because the two forms often ask about different facts. */
  answerLiteral: string; answerLatent: string;
}

/** Plant a needle at a controlled position among a book's chapters. */
function makeChunk(n: { id: string; book: string; text: string }, depth: string): Chunk {
  const chapters = store.chapters(n.book);
  const pick = depth === 'early' ? 0.15 : depth === 'middle' ? 0.5 : 0.85;
  const chapterIndex = chapters[Math.floor((chapters.length - 1) * pick)]?.index ?? 0;
  const meta = store.chunks.find((c) => c.bookId === n.book)!;
  return {
    id: `needle_${n.id}`,
    bookId: n.book,
    bookTitle: meta.bookTitle,
    author: meta.author,
    chapterIndex,
    chapterTitle: store.chapters(n.book).find((c) => c.index === chapterIndex)?.title ?? 'Unknown',
    chunkIndex: 999,
    text: n.text,
    wordCount: n.text.split(/\s+/).length,
  };
}

async function main() {
  store.load();
  const raw = JSON.parse(
    fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), 'needles.json'), 'utf8'),
  );
  // Two needle categories, reported separately. 'isolated' needles sit on topics
  // the corpus never discusses; 'camouflaged' needles sit on topics it is dense
  // in (balls, proposals, illness, letters, quarrels, great houses). The gap
  // between them is the measure of how much of a clean NIAH score is real.
  const needles: Needle[] = [
    ...raw.needles.map((n: any) => ({ ...n, category: 'isolated' })),
    ...raw.camouflaged.map((n: any) => ({ ...n, category: 'camouflaged' })),
  ];
  const trace = new Trace();

  // Embed and plant needles + distractors.
  const planted = needles.map((n) => makeChunk(n, n.depth));
  const distractors = raw.distractors.map((d: any) => makeChunk(d, 'middle'));
  // Multi-needle halves are planted in DIFFERENT books, so neither alone answers.
  const multiChunks = (raw.multi ?? []).flatMap((m: any) => [
    makeChunk({ id: `${m.id}a`, book: m.a.book, text: m.a.text }, 'middle'),
    makeChunk({ id: `${m.id}b`, book: m.b.book, text: m.b.text }, 'middle'),
  ]);
  const all = [...planted, ...distractors, ...multiChunks];
  const vectors = await embed(all.map((c) => c.text), trace, 'embed:needles');
  store.append(all, vectors);
  // BM25 is built from store.chunks, so it must be constructed AFTER planting.
  getBm25();

  console.log(
    `Planted ${planted.length} needles + ${distractors.length} distractors into ` +
      `${store.chunks.length - all.length} real chunks.\n`,
  );

  const rows: any[] = [];
  for (const n of needles) {
    for (const form of ['literal', 'latent'] as const) {
      const query = n[form];
      const needleId = `needle_${n.id}`;

      const useRerank = config.retrieval.rerank && !NO_RERANK;
      let hits = await retrieve({ query, k: useRerank ? Math.max(K * 3, 24) : K, mode: MODE });
      if (useRerank) hits = (await rerank(query, hits, K, trace)) as typeof hits;
      const rank = hits.findIndex((h) => h.chunk.id === needleId);

      let answered: boolean | null = null;
      let cited: boolean | null = null;
      if (!SKIP_ANSWER) {
        const r = await runChat([{ role: 'user', content: query }]);
        const a = (r.answer ?? '').toLowerCase();
        const key = (form === 'literal' ? n.answerLiteral : n.answerLatent).toLowerCase();
        answered = a.includes(key);
        cited = (r.answer ?? '').includes(needleId);
      }

      rows.push({ id: n.id, category: (n as any).category, book: n.book, depth: n.depth, form, rank: rank >= 0 ? rank + 1 : null, answered, cited });
      console.log(
        `${n.id} ${((n as any).category as string).padEnd(11)} ${n.depth.padEnd(6)} ${form.padEnd(7)} ` +
          `retrieved ${rank >= 0 ? `@${rank + 1}` : 'MISS'.padEnd(3)}` +
          (SKIP_ANSWER ? '' : `  answered ${answered ? 'yes' : 'NO '}  cited ${cited ? 'yes' : 'NO '}`),
      );
    }
  }

  const pct = (f: (r: any) => boolean) => `${((rows.filter(f).length / rows.length) * 100).toFixed(0)}%`;
  const byForm = (form: string, f: (r: any) => boolean) => {
    const g = rows.filter((r) => r.form === form);
    return `${((g.filter(f).length / g.length) * 100).toFixed(0)}%`;
  };

  console.log('\n--- summary ---');
  console.log(`retrieved@${K}   overall ${pct((r) => r.rank !== null)}   ` +
    `literal ${byForm('literal', (r) => r.rank !== null)}   latent ${byForm('latent', (r) => r.rank !== null)}`);
  if (!SKIP_ANSWER) {
    console.log(`answered      overall ${pct((r) => r.answered)}   ` +
      `literal ${byForm('literal', (r) => r.answered)}   latent ${byForm('latent', (r) => r.answered)}`);
    console.log(`cited         overall ${pct((r) => r.cited)}`);
  }

  console.log('\nby category (retrieval@' + K + '):');
  for (const cat of ['isolated', 'camouflaged']) {
    const g = rows.filter((r) => r.category === cat);
    const lit = g.filter((r) => r.form === 'literal');
    const lat = g.filter((r) => r.form === 'latent');
    console.log(
      `  ${cat.padEnd(12)} overall ${g.filter((r) => r.rank !== null).length}/${g.length}` +
        `   literal ${lit.filter((r) => r.rank !== null).length}/${lit.length}` +
        `   latent ${lat.filter((r) => r.rank !== null).length}/${lat.length}` +
        `   mean rank ${(g.filter((r) => r.rank).reduce((a, r) => a + r.rank, 0) / Math.max(1, g.filter((r) => r.rank).length)).toFixed(2)}`,
    );
  }

  console.log('\nby depth (retrieval):');
  for (const d of ['early', 'middle', 'late']) {
    const g = rows.filter((r) => r.depth === d);
    console.log(`  ${d.padEnd(7)} ${g.filter((r) => r.rank !== null).length}/${g.length}`);
  }

  // --- multi-needle: the aggregation case single-needle NIAH cannot test ---
  const multi = raw.multi ?? [];
  const multiRows: any[] = [];
  if (multi.length && !SKIP_ANSWER) {
    console.log('\n--- multi-needle (fact split across two passages) ---');
    for (const m of multi) {
      const r = await runChat([{ role: 'user', content: m.question }]);
      const ans = (r.answer ?? '').toLowerCase();
      const ids = (r.citations ?? []).map((c: any) => c.id);
      const gotA = ids.includes(`needle_${m.id}a`);
      const gotB = ids.includes(`needle_${m.id}b`);
      const saidA = ans.includes(m.keyA.toLowerCase());
      const saidB = ans.includes(m.keyB.toLowerCase());
      multiRows.push({ id: m.id, gotA, gotB, saidA, saidB });
      console.log(
        `${m.id}  retrieved A ${gotA ? 'yes' : 'NO '} B ${gotB ? 'yes' : 'NO '}` +
          `   answered A ${saidA ? 'yes' : 'NO '} B ${saidB ? 'yes' : 'NO '}` +
          `   BOTH ${saidA && saidB ? 'YES' : 'no'}`,
      );
    }
    const both = multiRows.filter((r) => r.saidA && r.saidB).length;
    const retrBoth = multiRows.filter((r) => r.gotA && r.gotB).length;
    console.log(`\nmulti-needle  retrievedBoth ${retrBoth}/${multiRows.length}   answeredBoth ${both}/${multiRows.length}`);
  }

  const out = path.join(config.paths.index, '..', 'eval', 'niah.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), k: K, rows, multiRows }, null, 2));
  console.log(`\nWrote ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
