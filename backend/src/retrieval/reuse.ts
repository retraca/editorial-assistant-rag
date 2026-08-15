import type { Chunk } from '../ingest/chunk.js';
import { store } from './store.js';

/**
 * Verbatim text-reuse detection by n-gram fingerprinting.
 *
 * This answers a different question from the embedding comparison, and the
 * difference is the whole point:
 *
 *   embeddings, "do these passages mean similar things?"   (thematic resemblance)
 *   fingerprints, "do these passages share actual wording?" (verbatim reuse)
 *
 * An editor reviewing "potential similarities between authors' work" needs both,
 * and needs to know which one fired. Embedding similarity of 0.68 says two
 * proposal scenes rhyme. A shared 8-word sequence says someone copied a line.
 * Only the second is evidence of derivation, and embeddings cannot produce it, 
 * two passages can be near-identical in vector space with no shared phrase.
 *
 * Method: word-level k-shingles, hashed, inverted-indexed. For a corpus this
 * size the inverted index makes it near-instant and there is no need for
 * MinHash/LSH approximation, those exist to avoid all-pairs comparison at
 * scales far beyond 1,359 chunks. See DECISIONS.md D-23.
 */

const K = 8; // shingle length in words. The standard 5-10 range for text reuse

/**
 * Function-word-only shingles ("and she said that she would not be") recur
 * across any two English novels and are noise, not reuse. Requiring at least
 * this many distinct non-stopword tokens keeps a shingle.
 */
const MIN_CONTENT_WORDS = 4;

const STOP = new Set(
  ('a an and are as at be been but by for from had has have he her hers him his i if in is it its me ' +
    'my not of on or our she that the their them then they this to was we were what when which who ' +
    'will with would you your so no do did does am were be')
    .split(' '),
);

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** FNV-1a, 32-bit. Fast, no dependency, collisions irrelevant at this scale. */
function hash(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function shingles(text: string, k = K): Map<number, string> {
  const words = normalise(text).split(' ').filter(Boolean);
  const out = new Map<number, string>();
  for (let i = 0; i + k <= words.length; i++) {
    const window = words.slice(i, i + k);
    const contentWords = new Set(window.filter((w) => !STOP.has(w)));
    if (contentWords.size < MIN_CONTENT_WORDS) continue;
    const phrase = window.join(' ');
    out.set(hash(phrase), phrase);
  }
  return out;
}

export interface ReuseMatch {
  a: Chunk;
  b: Chunk;
  sharedShingles: number;
  jaccard: number;
  longestSharedPhrase: string;
}

/**
 * Finds chunk pairs across two books that share verbatim word sequences.
 * `sameBookOk` exists for the self-comparison control (a book against itself
 * must surface its own overlapping chunks, which is how we know the detector
 * works at all).
 */
export function findReuse(
  bookA: string,
  bookB: string,
  opts: { minShared?: number; topN?: number } = {},
): { matches: ReuseMatch[]; comparedChunks: number; shinglesIndexed: number } {
  const minShared = opts.minShared ?? 1;
  const topN = opts.topN ?? 10;

  const idxA = store.chunks.map((c, i) => (c.bookId === bookA ? i : -1)).filter((i) => i >= 0);
  const idxB = store.chunks.map((c, i) => (c.bookId === bookB ? i : -1)).filter((i) => i >= 0);

  // Fingerprint side B once, into an inverted index: shingle hash -> chunk ids.
  const index = new Map<number, number[]>();
  const sizeB = new Map<number, number>();
  const phrases = new Map<number, string>();
  for (const j of idxB) {
    const sh = shingles(store.chunks[j].text);
    sizeB.set(j, sh.size);
    for (const [h, phrase] of sh) {
      let bucket = index.get(h);
      if (!bucket) index.set(h, (bucket = []));
      bucket.push(j);
      if (!phrases.has(h)) phrases.set(h, phrase);
    }
  }

  const matches: ReuseMatch[] = [];
  for (const i of idxA) {
    const sh = shingles(store.chunks[i].text);
    const shared = new Map<number, number[]>(); // chunk j -> shingle hashes
    for (const h of sh.keys()) {
      for (const j of index.get(h) ?? []) {
        if (i === j) continue; // a chunk trivially matches itself
        let hs = shared.get(j);
        if (!hs) shared.set(j, (hs = []));
        hs.push(h);
      }
    }
    for (const [j, hashes] of shared) {
      if (hashes.length < minShared) continue;
      const union = sh.size + (sizeB.get(j) ?? 0) - hashes.length;
      const longest = hashes
        .map((h) => phrases.get(h) ?? sh.get(h) ?? '')
        .sort((x, y) => y.length - x.length)[0] ?? '';
      matches.push({
        a: store.chunks[i],
        b: store.chunks[j],
        sharedShingles: hashes.length,
        jaccard: union > 0 ? hashes.length / union : 0,
        longestSharedPhrase: longest,
      });
    }
  }

  matches.sort((x, y) => y.sharedShingles - x.sharedShingles || y.jaccard - x.jaccard);
  // When a book is compared with itself, (i,j) and (j,i) are the same finding.
  const seen = new Set<string>();
  const deduped = matches.filter((m) => {
    const key = [m.a.id, m.b.id].sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    matches: deduped.slice(0, topN),
    comparedChunks: idxA.length * idxB.length,
    shinglesIndexed: index.size,
  };
}
