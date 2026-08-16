import fs from 'node:fs';
import path from 'node:path';
import { BOOKS, config } from '../config.js';
import { Trace } from '../trace.js';
import { embed } from '../azure.js';
import { parseBook } from './parse.js';
import { chunkSections, type Chunk } from './chunk.js';

/**
 * Offline index build: parse -> chunk -> embed -> persist.
 *
 * Run once via `npm run ingest`. Vectors are written as a flat Float32 binary
 * plus a JSON sidecar of metadata, which loads in milliseconds at boot.
 * See DECISIONS.md D-05 for why this is not a vector database.
 */

// 64 x ~400 words is roughly 34k tokens per request. This runs against an S0 tier
// deployment with a per-minute token budget, so batches are paced rather than
// fired back-to-back; without this the run trips a 429 around batch 6.
const BATCH = 64;
const PACE_MS = 1500;
const DRY_RUN = process.argv.includes('--dry-run');

/**
 * Cheapest form of contextual retrieval (CONTEXT_PREFIX=true).
 *
 * Anthropic's contextual retrieval generates a per-chunk summary of how the
 * chunk relates to its document, then prepends it before embedding, reported
 * to cut top-20 retrieval failures 35% alone, 49% with BM25. It costs one LLM
 * call per chunk: 1,359 calls here, which the deployment's rate limit makes
 * impractical (see D-20).
 *
 * This is the free approximation: prepend the book and chapter title, which we
 * already know from the structure, so the embedding carries where the passage
 * sits instead of only what it says. Only the *embedded* text changes. The
 * stored text, the UI and BM25 all see the original.
 */
const CONTEXT_PREFIX = process.env.CONTEXT_PREFIX === 'true';
const embedText = (c: { bookTitle: string; chapterTitle: string; text: string }) =>
  CONTEXT_PREFIX ? `${c.bookTitle}, ${c.chapterTitle}\n\n${c.text}` : c.text;

async function main() {
  const trace = new Trace();
  const allChunks: Chunk[] = [];

  for (const book of BOOKS) {
    const html = fs.readFileSync(path.join(config.paths.books, book.file), 'utf8');
    const sections = parseBook(html);
    const chunks = chunkSections(sections, book);
    allChunks.push(...chunks);

    const words = sections.reduce((n, s) => n + s.wordCount, 0);
    const sizes = chunks.map((c) => c.wordCount).sort((a, b) => a - b);
    const pct = (p: number) => sizes[Math.floor((sizes.length - 1) * p)];
    const mean = Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length);
    console.log(
      `${book.title.padEnd(20)} ${String(sections.length).padStart(3)} chapters  ` +
        `${String(words).padStart(7)} words  ${String(chunks.length).padStart(4)} chunks  ` +
        `| chunk words: mean ${mean} p10 ${pct(0.1)} p50 ${pct(0.5)} p90 ${pct(0.9)} max ${sizes.at(-1)}`,
    );
  }

  if (DRY_RUN) {
    console.log('\n--dry-run: skipping embeddings.');
    console.log('\nSample chunk:\n', JSON.stringify(allChunks[5], null, 2).slice(0, 900));
    return;
  }

  console.log(
    `\nEmbedding ${allChunks.length} chunks (${config.embeddingDims}d) in batches of ${BATCH}` +
      `${CONTEXT_PREFIX ? ', with book/chapter context prefix' : ''}...`,
  );
  const vectors: Float32Array[] = [];
  for (let i = 0; i < allChunks.length; i += BATCH) {
    const batch = allChunks.slice(i, i + BATCH);
    vectors.push(...(await embed(batch.map(embedText), trace, `embed:${i}`)));
    process.stdout.write(`\r  ${Math.min(i + BATCH, allChunks.length)}/${allChunks.length}`);
    if (i + BATCH < allChunks.length) await new Promise((r) => setTimeout(r, PACE_MS));
  }
  console.log();

  fs.mkdirSync(config.paths.index, { recursive: true });

  const buf = Buffer.alloc(vectors.length * config.embeddingDims * 4);
  vectors.forEach((v, i) => {
    Buffer.from(v.buffer, v.byteOffset, v.byteLength).copy(buf, i * config.embeddingDims * 4);
  });
  fs.writeFileSync(path.join(config.paths.index, 'vectors.f32'), buf);
  fs.writeFileSync(
    path.join(config.paths.index, 'chunks.json'),
    JSON.stringify({ dims: config.embeddingDims, builtAt: new Date().toISOString(), chunks: allChunks }),
  );

  const s = trace.summary();
  console.log(
    `\nIndexed ${allChunks.length} chunks -> data/index/ ` +
      `(${(buf.length / 1024 / 1024).toFixed(1)} MB vectors)\n` +
      `Embedding tokens: ${s.usage.embeddingTokens}  est. cost: $${s.estimatedCostUsd.toFixed(4)}  ` +
      `elapsed: ${(s.totalMs / 1000).toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
