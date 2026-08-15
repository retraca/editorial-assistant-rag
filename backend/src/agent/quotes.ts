import type { Chunk } from '../ingest/chunk.js';

/**
 * Verbatim check on every quotation in an answer.
 *
 * WHY THIS IS NOT AN LLM CALL. A quotation is the one claim in an answer whose
 * correctness is decidable by string comparison. Asking a model whether a
 * quotation is accurate is slower, costs money, and is less reliable than
 * checking, and the semantic judge demonstrably misses these: it passed an
 * answer that quoted Aunt March as saying Meg would marry a man "with money,
 * position, or business" when the book says "without", because topically the
 * information was all present. Reversing a quoted judgement is the most
 * damaging error an editorial tool can make, and it is free to catch.
 *
 * The asymmetry this closes: chapter notes have verified their quotations
 * character by character since D-43, and answers never did.
 *
 * MATCHING IS DELIBERATELY LOOSE ON PUNCTUATION, STRICT ON WORDS. Curly and
 * straight apostrophes, trailing commas and internal line breaks are all
 * artefacts of the source rather than of the quotation, and flagging them would
 * bury a real misquote in noise. Dropping or changing a WORD is what matters.
 * See DECISIONS.md D-64.
 */

/**
 * Minimum words for a span to count as a quotation rather than emphasis.
 *
 * Four was too low. "domestic life and moral lessons" in quotation marks is a
 * writer stressing a phrase, not claiming Alcott wrote those five words in that
 * order, and failing a whole answer for it is the crying-wolf failure again.
 * Six still catches every planted corruption, which is the number that decides
 * this rather than taste.
 */
const MIN_WORDS = 6;

/**
 * Curly quotes are directional and pair unambiguously. Straight quotes are not,
 * and a naive pattern pairs the CLOSING quote of one span with the OPENING
 * quote of the next: `The word "money" recurs, and so does "position"` yielded
 * ` recurs, and so does ` as a quotation, which then failed as a misquote.
 * Requiring a non-space character at both ends rules that out, because the text
 * between two quotations always begins and ends with a space.
 */
const QUOTED = [
  /[“]([^”]{8,400})[”]/g,
  /"([^"\s][^"]{6,398}[^"\s])"/g,
];

/**
 * Words only, lowercased. Apostrophes and quote marks are DROPPED rather than
 * normalised, on both sides, so "don't" and "dont" agree and, more importantly,
 * a nested quotation inside a quotation stops breaking the match: an answer
 * writing `said in her ear, 'No matter'` against a source rendering the inner
 * quote differently produced a spurious misquote.
 */
const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export interface QuoteCheck {
  checked: number;
  /**
   * Quoted text appearing NOWHERE in the books. Fabricated, or lifted from
   * something that is not the corpus at all. A defect either way.
   */
  misquoted: string[];
  /**
   * Real text from the books that was not among the passages retrieved for this
   * question. Not a defect: the assistant also reads chapter notes, whose
   * quotations were verified against the text at ingest (D-43).
   */
  unretrieved: string[];
  ok: boolean;
}

/**
 * `corpus` is the authority on whether a quotation is real. `retrieved` only
 * decides whether it came from this question's evidence.
 *
 * Checking against `retrieved` alone was wrong, and wrong the same way twice
 * before: D-61 judged claims against the cited passage rather than all of them,
 * and D-62 called a claim unsupported when the search had merely missed the
 * passage. An answer built from chapter notes cites no passages at all, so every
 * quotation in it was reported as fabricated while being verbatim Alcott.
 *
 * The distinction earns its keep in the other direction too. "no wording at all,
 * not a single phrase in common" appears in no chunk of either novel, because it
 * is a sentence THIS SYSTEM generates in its comparison output. An assistant
 * quoting our own machinery back at an editor is what D-36 forbids, and only a
 * corpus-wide check separates that from a legitimate quotation.
 */
export function checkQuotes(answer: string, retrieved: Chunk[], corpus: Chunk[] = []): QuoteCheck {
  const haystacks = retrieved.map((c) => norm(c.text));
  const all = haystacks.join('  '); // a separator no quotation can span
  const wider = corpus.map((c) => norm(c.text));
  const misquoted: string[] = [];
  const unretrieved: string[] = [];
  let checked = 0;

  const spans = QUOTED.flatMap((re) => [...answer.matchAll(re)].map((m) => m[1]));
  for (const span of spans) {
    const raw = span.trim();
    // Two legitimate editorial marks split a quotation into parts that are each
    // verbatim while the whole is not:
    //   ellipsis   a deliberate omission
    //   [brackets] a word substituted for clarity, "persuaded [Georgiana] to
    //              believe herself in love" where the source says "persuaded her"
    // Both are standard practice and neither is an error, so each part is
    // checked on its own and the joins are not.
    const parts = raw
      .split(/\s*(?:\.{3}|…)\s*|\s*\[[^\]]*\]\s*/)
      .map(norm)
      .filter((p) => p.split(' ').length >= MIN_WORDS);
    if (!parts.length) continue;
    checked++;
    const inRetrieved = parts.every((p) => all.includes(p) || haystacks.some((h) => h.includes(p)));
    if (inRetrieved) continue;
    const inCorpus = wider.length && parts.every((p) => wider.some((h) => h.includes(p)));
    (inCorpus ? unretrieved : misquoted).push(raw);
  }

  return { checked, misquoted, unretrieved, ok: misquoted.length === 0 };
}
