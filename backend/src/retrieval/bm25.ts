import type { Chunk } from '../ingest/chunk.js';
import { topK, type Scored } from './store.js';
import { aliasExpansions } from './aliases.js';

/**
 * BM25 over the chunk corpus, ~60 lines and no dependency.
 *
 * Why lexical search at all when we have embeddings: editors search for proper
 * nouns. "Wickham", "Netherfield", "Marmee" are exactly the queries where a
 * dense model can drift to semantically-similar-but-wrong passages, while an
 * exact term match is decisive. See DECISIONS.md D-06.
 *
 * k1=1.2, b=0.75 are the standard Robertson/Sparck-Jones defaults. Chunks are
 * near-uniform in length by construction (p10 220, p90 349 words), so b. The
 * length-normalisation weight, has little to do here either way.
 */

const K1 = 1.2;
const B = 0.75;
/** Weight applied to alias-expanded terms. 0 disables expansion entirely. */
const ALIAS_WEIGHT = Number(process.env.ALIAS_WEIGHT ?? 0.3);

// Deliberately tiny: these carry no signal but appear in nearly every chunk.
const STOP = new Set(
  ('a an and are as at be but by for from had has have he her hers him his i if in is it its me my ' +
    'of on or our she that the their them they this to was we were what when which who will with you your')
    .split(' '),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Curly apostrophes are pervasive in both books; normalise so "don’t" and
    // "don't" tokenise identically.
    .replace(/[‘’]/g, "'")
    .match(/[a-z0-9']+/g)
    ?.filter((t) => t.length > 1 && !STOP.has(t)) ?? [];
}

export class BM25 {
  private df = new Map<string, number>();
  private tf: Map<string, number>[] = [];
  private lengths: number[] = [];
  private avgLen = 0;
  private n = 0;

  constructor(private chunks: Chunk[]) {
    this.n = chunks.length;
    for (const chunk of chunks) {
      const terms = tokenize(chunk.text);
      const counts = new Map<string, number>();
      for (const t of terms) counts.set(t, (counts.get(t) ?? 0) + 1);
      this.tf.push(counts);
      this.lengths.push(terms.length);
      for (const t of counts.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avgLen = this.lengths.reduce((a, b) => a + b, 0) / (this.n || 1);
  }

  private idf(term: string): number {
    const df = this.df.get(term) ?? 0;
    // Robertson-Sparck-Jones IDF with the +1 guard so common terms floor at ~0
    // instead of going negative.
    return Math.log(1 + (this.n - df + 0.5) / (df + 0.5));
  }

  /**
   * Highest IDF among the query's terms. A measure of whether the query has
   * any *distinctive* lexical anchor. "Mrs Younge" scores high (one chunk
   * contains it); "how did she feel about the proposal" scores low (every term
   * is common). Used to decide whether the sparse arm is worth consulting.
   */
  maxIdf(query: string): number {
    const terms = tokenize(query);
    if (!terms.length) return 0;
    return Math.max(...terms.map((t) => (this.df.get(t) ? this.idf(t) : 0)));
  }

  search(query: string, k: number, filter?: (c: Chunk) => boolean): Scored[] {
    const terms = tokenize(query);
    if (!terms.length) return [];

    // Character aliases, down-weighted: "Lizzy" should reach Elizabeth passages,
    // but a word the user actually typed is stronger evidence than one we
    // inferred. See aliases.ts and DECISIONS.md D-25.
    const expansions = ALIAS_WEIGHT > 0 ? aliasExpansions(terms) : [];
    const weights = new Map<string, number>(terms.map((t) => [t, 1]));
    for (const e of expansions) if (!weights.has(e)) weights.set(e, ALIAS_WEIGHT);

    const all = [...weights.keys()];
    const idfs = new Map(all.map((t) => [t, this.idf(t)]));

    const out: Scored[] = [];
    for (let i = 0; i < this.n; i++) {
      const chunk = this.chunks[i];
      if (filter && !filter(chunk)) continue;
      let score = 0;
      const counts = this.tf[i];
      const norm = K1 * (1 - B + (B * this.lengths[i]) / this.avgLen);
      for (const term of all) {
        const f = counts.get(term);
        if (!f) continue;
        score += (weights.get(term) ?? 1) * (idfs.get(term) ?? 0) * ((f * (K1 + 1)) / (f + norm));
      }
      if (score > 0) out.push({ chunk, score });
    }
    return topK(out, k);
  }
}
