/**
 * Character alias expansion for the lexical arm.
 *
 * The problem, measured: BM25 treats "Lizzy" and "Elizabeth" as unrelated
 * tokens, top-5 overlap between the two queries is 0/5. Dense partially bridges
 * them (3/5), but fusion then discards that bridge, because RRF prefers
 * documents both arms agree on and BM25 agrees with nothing. So hybrid scores
 * *worse* than dense alone on alias queries, while scoring better on rare exact
 * names. Expanding aliases into the sparse arm removes that trade-off.
 *
 * Applied at QUERY time only, never at index time: the index keeps the author's
 * actual words, so a passage is always cited exactly as written.
 *
 * Which groups exist is a measured decision, not a guess. Counting chunks
 * containing each token:
 *
 *   elizabeth   2 in Little Women, 411 in Pride & Prejudice
 *   beth      299 in Little Women,   0 in Pride & Prejudice
 *
 * Beth March's formal name IS Elizabeth, so the "obvious" beth->elizabeth link
 * would pull 411 Austen passages into every Alcott query. It is deliberately
 * absent. Every group below was checked for the same cross-book collision.
 *
 * Honest limitation: this map is hand-curated and therefore corpus-specific. It
 * does not generalise to a third book. The generalising version derives aliases
 * by NER plus coreference clustering over each document, which is a pipeline in
 * its own right and out of scope here. See DECISIONS.md D-25.
 */

const GROUPS: string[][] = [
  // Pride and Prejudice
  ['elizabeth', 'lizzy', 'eliza'],
  ['fitzwilliam', 'darcy'],
  // Little Women
  ['jo', 'josephine'],
  ['meg', 'margaret'],
  ['laurie', 'theodore', 'laurence'],
  ['marmee', 'march'],
  // NOT included, and the reason is the point:
  //   ['beth', 'elizabeth']  -> 411 Pride & Prejudice chunks contain "elizabeth"
];

/** token -> every alias in its group (excluding itself) */
const MAP = new Map<string, string[]>();
for (const group of GROUPS) {
  for (const term of group) {
    const others = group.filter((t) => t !== term);
    MAP.set(term, [...(MAP.get(term) ?? []), ...others]);
  }
}

/**
 * Returns the extra tokens implied by a query's aliases. Kept separate from the
 * original tokens so the caller can weight them differently. An alias is
 * weaker evidence than the word the user actually typed.
 */
export function aliasExpansions(tokens: string[]): string[] {
  const extra = new Set<string>();
  const original = new Set(tokens);
  for (const t of tokens) {
    for (const alias of MAP.get(t) ?? []) {
      if (!original.has(alias)) extra.add(alias);
    }
  }
  return [...extra];
}

