import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolve the project root by walking up until we find `data/books`, rather
 * than counting `..` hops. Counting breaks the moment the entrypoint moves
 * between `src/` (tsx) and `dist/` (compiled, which is what Docker runs).
 */
function findRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'data', 'books'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate project root (no data/books above ${start})`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = process.env.PROJECT_ROOT ?? findRoot(here);

dotenv.config({ path: path.join(ROOT, '.env') });

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const config = {
  /**
   * Per-claim verification after generation (D-61). One extra call per answer.
   * Default decided by measurement, see the entry: it catches real additions and
   * its false-positive rate on known-good answers is what settles whether a
   * guardrail helps or trains the reader to ignore it.
   */
  claimCheck: (process.env.CLAIM_CHECK ?? 'true') === 'true',
  /**
   * Characters of each passage sent to the claim judge. 0 sends them whole,
   * which is what ships. Truncating looked like an easy saving because that call
   * is the largest single cost, and measuring killed it: at 900 characters the
   * false-flag rate on unmodified answers went from 3/14 to 10/14, because the
   * text supporting a claim is frequently past the cut. Kept as a knob only
   * because the measurement is worth being able to repeat.
   */
  claimPassageChars: num('CLAIM_PASSAGE_CHARS', 0),
  /**
   * Which API the same two models are reached through.
   *
   * The default build talks to an Azure deployment; the hosted demo runs on an
   * OpenAI key instead, so a key with a wider blast radius is never sitting
   * behind a URL anyone can find. Same models either way: `text-embedding-3-large` at
   * 1,024 dimensions produces the same vector space, so the shipped index is
   * reused rather than rebuilt.
   */
  provider: (process.env.LLM_PROVIDER ?? 'azure') as 'azure' | 'openai',
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseUrl: (process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, ''),
    chatModel: process.env.OPENAI_CHAT_MODEL ?? 'gpt-5.1-chat-latest',
    embeddingModel: process.env.OPENAI_EMBEDDING_MODEL ?? 'text-embedding-3-large',
  },
  /**
   * Public demo controls. All inert when unset, so the local build is
   * unchanged: no password, no ceiling, no database.
   */
  demo: {
    password: process.env.DEMO_PASSWORD ?? '',
    questionsPerHour: num('DEMO_QUESTIONS_PER_HOUR', 0),
    dbPath: process.env.DEMO_DB_PATH ?? '',
  },
  azure: {
    apiKey: process.env.LLM_PROVIDER === 'openai' ? (process.env.AZURE_OPENAI_API_KEY ?? '') : req('AZURE_OPENAI_API_KEY'),
    endpoint: (process.env.LLM_PROVIDER === 'openai'
      ? (process.env.AZURE_OPENAI_ENDPOINT ?? 'https://unused.invalid')
      : req('AZURE_OPENAI_ENDPOINT')).replace(/\/$/, ''),
    apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-12-01-preview',
    chatDeployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-5.1-chat',
    embeddingDeployment: process.env.AZURE_EMBEDDING_DEPLOYMENT ?? 'text-embedding-3-large',
    embeddingApiVersion: process.env.AZURE_EMBEDDING_API_VERSION ?? '2024-12-01-preview',
  },
  embeddingDims: num('EMBEDDING_DIMS', 1024),
  chunk: {
    targetWords: num('CHUNK_TARGET_WORDS', 350),
    overlapWords: num('CHUNK_OVERLAP_WORDS', 60),
  },
  retrieval: {
    k: num('RETRIEVAL_K', 8),
    rrfK: num('RRF_K', 10),
    /**
     * Second-stage reranking. ON by default, see DECISIONS.md D-20.
     *
     * Enabled on evidence, and this reverses an earlier decision: a paired
     * bootstrap on the held-out set gives +8.3pp chapter-level recall,
     * 95% CI [1.7, 16.7], which excludes zero. It buys genuine recall rather
     * than reordering, because we over-fetch 24 candidates and cut to k. So a
     * better ranking selects a better k. Costs ~$0.0065 and ~4.8s per query.
     */
    rerank: (process.env.RERANK ?? 'true') === 'true',
    /**
     * Pull the chunks either side of the top N hits into the result.
     *
     * This is what actually solves the boundary problem chunk overlap was
     * supposed to solve. Overlap heals a seam only when both halves of what is
     * needed fall inside the ~75-word carried window: 11 of 30 seams, and
     * raising it to 150 words gets 12, because the limit is where the
     * information sits rather than how wide the window is. Fetching a neighbour
     * restores the whole adjacent chunk and heals every seam. See D-68.
     *
     * 0 disables.
     */
    neighbours: num('RETRIEVAL_NEIGHBOURS', 2),
    /** Characters of each candidate sent to the reranker. Swept in D-69. */
    rerankChars: num('RERANK_CHARS', 700),
  },
  // See DECISIONS.md D-11: assumed rates, used to make cost visible/relative.
  pricing: {
    llmInputPerM: num('PRICE_LLM_INPUT_PER_M', 1.25),
    llmOutputPerM: num('PRICE_LLM_OUTPUT_PER_M', 10.0),
    embeddingPerM: num('PRICE_EMBEDDING_PER_M', 0.13),
    /** Cached input multiplier. 0.25 is the common industry rate; ASSUMED here. */
    cachedInputDiscount: num('PRICE_CACHED_INPUT_MULTIPLIER', 0.25),
  },
  port: num('PORT', 8080),
  paths: {
    books: path.join(ROOT, 'data', 'books'),
    index: path.join(ROOT, 'data', 'index'),
  },
};

export const BOOKS = [
  { id: 'little_women', title: 'Little Women', author: 'Louisa May Alcott', file: 'little_women.html' },
  { id: 'pride_prejudice', title: 'Pride and Prejudice', author: 'Jane Austen', file: 'pride_prejudice.html' },
] as const;

export type BookId = (typeof BOOKS)[number]['id'];
