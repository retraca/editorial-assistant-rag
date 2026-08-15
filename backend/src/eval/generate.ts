import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { store } from '../retrieval/store.js';
import { chat } from '../azure.js';
import { Trace } from '../trace.js';

/**
 * Synthetic eval generation.
 *
 * The hand-written set saturated when this was written, at 20/20, and still does at its
 * current 24/24, which makes it a breakage alarm and
 * nothing more. You cannot tell whether a change helped. This builds a harder,
 * larger set straight from the corpus:
 *
 *   1. sample N chunks (deterministic stride, so runs are comparable)
 *   2. ask the model for a question answerable ONLY from that chunk, using
 *      different vocabulary than the passage wherever possible
 *   3. the chunk it came from is the gold answer
 *
 * Paraphrase is the point. A question that reuses the passage's own wording
 * tests BM25's ability to match strings, which we already know works. Forcing
 * different vocabulary tests whether retrieval finds the right passage when the
 * easy lexical path is removed.
 *
 * Known weakness, stated rather than hidden: the generator and the system under
 * test share a model family, and "answerable only by this chunk" is the model's
 * judgement, not a verified property. Some questions will be answerable from
 * neighbouring chunks, which makes measured recall a slight underestimate. It is
 * a relative instrument for comparing configurations, not an absolute score.
 *
 * Run: npm run eval:generate -- [count]
 */

const COUNT = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 60);
const BATCH = 10;
/**
 * Sampling offset. The dev set uses offset 0; the held-out test set uses a
 * different offset so the two draw from disjoint chunks. Tuning happens on dev;
 * the test set is measured once, at the end, and never tuned against.
 */
const OFFSET = Number(process.argv.find((a) => a.startsWith('--offset='))?.split('=')[1] ?? 0);
const OUT = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1] ?? 'cases-generated.json';

const SYSTEM = `You write retrieval evaluation questions for a search system over classic novels.

For each numbered passage, write ONE question that:
- is answerable from that passage alone, using a specific detail in it
- a reader who had not seen the passage could still ask naturally
- AVOIDS reusing distinctive wording from the passage, paraphrase instead.
  If the passage says "she was mortified by his proposal", ask about
  "how she reacted when he asked to marry her", not "was she mortified".
- names people or places only if that is essential to make the question specific
- is one sentence, no preamble

Return JSON: {"questions":[{"index":0,"question":"..."}]}`;

async function main() {
  store.load();
  const trace = new Trace();

  // Deterministic stride rather than random sampling: no Math.random, and two
  // runs are directly comparable.
  const stride = Math.max(1, Math.floor(store.chunks.length / COUNT));
  const sampled = store.chunks.filter((_, i) => i % stride === OFFSET % stride).slice(0, COUNT);

  console.log(`Generating ${sampled.length} cases (stride ${stride}, offset ${OFFSET}) -> ${OUT}`);

  const cases: any[] = [];
  for (let i = 0; i < sampled.length; i += BATCH) {
    const batch = sampled.slice(i, i + BATCH);
    const body = batch
      .map((c, j) => `### Passage ${j}\n(${c.bookTitle}, ${c.chapterTitle})\n${c.text.slice(0, 1500)}`)
      .join('\n\n');

    const { message } = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: body },
      ],
      jsonMode: true,
      maxTokens: 1600,
      trace,
      label: `generate:${i}`,
    });

    try {
      const parsed = JSON.parse(message.content ?? '{}');
      for (const q of parsed.questions ?? []) {
        const chunk = batch[q.index];
        if (!chunk || !q.question) continue;
        cases.push({
          id: `gen-${cases.length}`,
          query: q.question,
          goldChunkId: chunk.id,
          goldBook: chunk.bookId,
          goldChapter: chunk.chapterIndex,
        });
      }
    } catch {
      console.warn(`  batch ${i} returned unparseable JSON, skipped`);
    }
    process.stdout.write(`\r  ${cases.length}/${sampled.length}`);
    await new Promise((r) => setTimeout(r, 800));
  }
  console.log();

  const out = path.join(path.dirname(new URL(import.meta.url).pathname), OUT);
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), cases }, null, 2));
  const s = trace.summary();
  console.log(`Wrote ${cases.length} cases -> ${out}`);
  console.log(`Cost: $${s.estimatedCostUsd.toFixed(4)}  elapsed ${(s.totalMs / 1000).toFixed(0)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
