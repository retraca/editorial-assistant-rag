import { chat } from '../azure.js';
import { Trace } from '../trace.js';
import { retrieve } from '../retrieval/hybrid.js';
import type { Chunk } from '../ingest/chunk.js';
import { splitSentences } from '../ingest/chunk.js';
import { config } from '../config.js';
import { checkQuotes } from './quotes.js';
import { store } from '../retrieval/store.js';

/**
 * Output guardrail: does each sentence follow from the evidence gathered?
 *
 * The gap this closes. The citation audit (D-18) proves a citation is real and
 * was retrieved this turn. It says nothing about whether the sentence beside it
 * is supported by anything at all. Every recurring failure in this system
 * lives in that gap: "Wickham squandered the money" beside a passage that says
 * only that he received it, "Amy burned the manuscript because Jo refused to
 * take her to the theatre" beside a passage that never mentions the theatre.
 * Both cite correctly. Both add a fact.
 *
 * Why a separate pass rather than a better prompt. Eight prompt rules already
 * forbid this and it still happens, because the model cannot check its own
 * output against evidence it has already stopped attending to. See D-61.
 *
 * IT REPORTS, IT DOES NOT REWRITE. Same reasoning as the citation audit:
 * silently softening an unsupported sentence would hide the signal an editor
 * needs. An editor deciding whether to trust an answer is better served by
 * "no retrieved passage mentions the theatre" than by a smoother paragraph.
 *
 * The false-positive problem is the real design constraint. A guardrail that
 * fires on normal usage gets ignored, and this system has already learned that
 * once (D-30, the citation audit firing on every follow-up). So the judge is
 * told to allow paraphrase, allow summary, allow combining several passages,
 * and to flag only claims carrying information no retrieved passage contains.
 */

const SYSTEM = `You check whether each numbered claim is supported by the passages given.

The passages are everything the writer had available. A claim may draw on any of them, in any
combination. Do not require a claim to match the passage whose id happens to sit beside it.

Return JSON: {"verdicts": [{"n": 1, "supported": true, "kind": "fact", "missing": ""}, ...]}

"supported": true if the passages contain the information the claim asserts. Judge the INFORMATION,
not the wording.

"kind": only meaningful when unsupported. Two very different things get flagged and a reader needs
them apart:

  "fact"      the claim asserts something that COULD have been in a passage and is not. An event, a
              motive, a consequence, a name, a number, a quotation. If a passage existed saying this,
              the claim would be supported. This is a defect.

  "inference" the claim is the writer's own judgement, and no passage could settle it either way.
              Evaluations ("the stronger novel", "more controlled structurally"), claims about
              readers or reception ("readers often debate this"), aesthetic comparisons, and
              statements about what a book does NOT do or aim for. Reporting these as missing
              evidence is wrong: they were never evidential claims. They still need marking, because
              the reader must know which sentences came from the books and which did not.

When in doubt between the two, choose "inference" only if no passage could possibly settle it.

ALLOW, these are all supported:
- a statement that the search found nothing: "I could not find X", "no passage mentions Y", "the
  retrieved passages do not say Z". These describe the SEARCH, not the book. There is no passage that
  could support an absence, and reporting one honestly is the behaviour we want.
- paraphrase, compression, and summary in different words
- a claim drawing on several of the passages together, or on a passage other than the one it marks
- quoting a phrase that appears in a passage
- ordinary connective language ("she then says", "the passage shows")
- a stated interpretation the writer marks as a reading, if the line it rests on is present

FLAG as unsupported when either of these is true:

(a) ABSENT. The claim carries information that appears in NO passage: a motive not stated, an event
    not described, a consequence not mentioned, a name or number not present, or a generalisation
    about the whole book that the passages cannot establish.

(b) CONTRADICTED. A passage says something and the claim says otherwise. This is not an absence, it
    is a conflict, and it is the more serious of the two. Look specifically for:
      - a dropped or added negation. A passage saying "a man WITHOUT money" reported as "a man with
        money" reverses the meaning while every word looks familiar.
      - who did what to whom, swapped.
      - a number, sum or count changed.
      - an outcome reversed: accepted for refused, forgave for never forgave, went for stayed.
    Topical familiarity is exactly why these slip through. Check the direction of the claim against
    the direction of the passage, not just the subject matter. Mark these "fact" and say what the
    passage actually says.

"missing": if unsupported, name the specific piece of information that is absent, in under fifteen
words. Empty when supported.

On ABSENCE, be conservative: if a reasonable editor would say the passages carry the claim, it is
supported. On CONTRADICTION, do not be conservative: a reversal is a defect however fluent it reads.`;

export interface ClaimVerdict {
  claim: string;
  supported: boolean;
  /**
   * A defect or a judgement. A `fact` claim asserts something a passage could
   * have carried and none does. An `inference` is the assistant's own reading,
   * which no passage could settle either way. See D-63.
   */
  kind: 'fact' | 'inference';
  /** What the passages do not contain. Shown to the reader verbatim. */
  missing: string;
  /** Passage ids printed beside this claim, for the reader to open. */
  cited: string[];
}

export interface ClaimAudit {
  checked: number;
  /**
   * Quotations that appear in no retrieved passage. Checked in code, not by a
   * model: it is the one claim decidable by string comparison, and the semantic
   * judge misses reversals like "with money" for "without money" (D-64).
   */
  misquoted: string[];
  /** Asserts something no passage supports and a passage could have carried. */
  unsupported: ClaimVerdict[];
  /** The assistant's own judgement. Marked, not treated as an error. */
  inferences: ClaimVerdict[];
  /**
   * Flagged against the passages retrieved for the question, then supported by a
   * passage found on a second, targeted search. These are RETRIEVAL misses, not
   * fabrications, and conflating the two was the bug this pass exists to fix.
   */
  recovered: ClaimVerdict[];
  /** Passages found by the recovery search, so the reader can open them. */
  extraCitations: Chunk[];
  ok: boolean;
}

const CITATION_RE = /\[([a-z_]+:\d+:\d+)\]/g;

/**
 * Sentences that carry a citation, paired with the passages they cite.
 *
 * A sentence with no citation of its own inherits the citations of the sentence
 * before it, because an answer commonly cites once and then continues about the
 * same passage. Sentences before any citation are skipped: there is nothing to
 * check them against, and the uncited case is already the citation audit's job.
 */
export function claimsOf(answer: string, byId: Map<string, Chunk>): { text: string; cited: string[] }[] {
  const out: { text: string; cited: string[] }[] = [];
  let carried: string[] = [];

  // Headings are dropped before anything is split. A heading carries no
  // terminator, so the sentence splitter glued it to the paragraph beneath and
  // the reader was shown '"## Pride and Prejudice Most of the water imagery
  // comes during the visit to Pemberley."' as a statement to distrust.
  const prose = answer
    .split('\n')
    .filter((line) => !/^\s*(#{1,4}\s|\*\*[^*]+\*\*\s*:?\s*$)/.test(line))
    .join('\n');

  // Line by line, then sentences within a line. A list item carries no terminal
  // punctuation, so splitting the whole block at once glued an entire bulleted
  // list AND the paragraph after it into one "statement", and the reader was
  // shown that as a single thing to check. A newline is a harder boundary than a
  // full stop in model output, so it is treated as one.
  const lines = prose.split('\n').flatMap((line) => splitSentences(line));

  for (const raw of lines) {
    // Strip the bullet; what follows is the claim, if it is one at all.
    const bulleted = /^\s*[-*\u2022]\s+/.test(raw);
    const sentence = raw.trim().replace(/^\s*[-*\u2022]\s+/, '');
    if (!sentence) continue;
    const ids = [...sentence.matchAll(CITATION_RE)].map((m) => m[1]).filter((id) => byId.has(id));
    if (ids.length) carried = ids;
    const cited = ids.length ? ids : carried;
    if (!cited.length) continue;

    // Strip the citation markers and any heading syntax; what remains is the claim.
    const text = sentence.replace(CITATION_RE, '').replace(/^#{1,4}\s*/, '').replace(/\s+/g, ' ').trim();
    // A heading or a stub carries no assertion to check. A bulleted line needs
    // more than that: a list in this system is usually labels rather than
    // sentences, and "March home / March garden" clears five words while
    // asserting nothing an audit could weigh.
    if (text.split(' ').length < (bulleted ? 7 : 5)) continue;
    // "I could not find a cat in Pride and Prejudice" is a statement about the
    // search, not about the book, and there is no passage that could support
    // it. Flagging it punished the assistant for reporting an honest miss,
    // which is the behaviour the whole system is built to encourage (D-83).
    // Narrowly: the SUBJECT has to be the search or this system. The first
    // version matched any negation near a reporting verb, which exempted
    // "Darcy did not mention the estate to anyone" too. That is a claim about
    // the book and belongs in the audit; the exemption cost recall (D-83).
    const aboutTheSearch =
      /^(i|we)\s+(could not|couldn't|did not|didn't|cannot|can't|was unable to|found no)\b/i.test(text) ||
      /^(no|none of the|nothing in the)\s+(passage|passages|retrieved|search|result|results|text)\b/i.test(text) ||
      /^the\s+(passages?|retrieved passages?|search|results?)\s+(do|does|did)\s+not\b/i.test(text) ||
      /^(no|nothing)\b[^.]{0,30}\b(was|were)\s+(found|retrieved)\b/i.test(text);

    // Sentences addressed to the READER are not claims about the books, and the
    // audit has no jurisdiction over them. "If you mean a different John, give me
    // a little more context" was being reported as judgement no passage could
    // settle, which is true and useless: it is an offer, not an assertion. Same
    // reasoning as the exemption above, pointed at the other kind of sentence
    // that is not about the corpus. Second person plus a request, or a bare
    // imperative asking for input.
    const toTheReader =
      /^if you (mean|meant|want|would like|are looking|had)\b/i.test(text) ||
      /\b(let me know|tell me|give me|say the word|ask me)\b/i.test(text) ||
      /^(would you|do you|shall i|want me to|i can (search|look|check))\b/i.test(text);

    if (aboutTheSearch || toTheReader) continue;
    out.push({ text, cited });
  }
  return out;
}

/**
 * Judges claims against a set of passages. Returns only the UNSUPPORTED ones,
 * keyed by their index, with the missing information named.
 *
 * Shared by both passes deliberately: the second look must apply exactly the
 * same standard as the first, or "recovered" would mean "judged more leniently"
 * rather than "evidence was found".
 */
type Flag = { missing: string; kind: 'fact' | 'inference' };

async function judge(claims: string[], passages: Chunk[], trace?: Trace): Promise<Map<number, Flag>> {
  const out = new Map<number, Flag>();
  if (!claims.length || !passages.length) return out;

  const cut = config.claimPassageChars;
  const evidence = passages
    .map((c) => `[${c.id}] ${cut > 0 ? c.text.slice(0, cut) : c.text}`)
    .join('\n\n');
  const numbered = claims.map((c, i) => `CLAIM ${i + 1}: ${c}`).join('\n');
  try {
    const { message } = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `PASSAGES:\n\n${evidence}\n\n---\n\nCLAIMS:\n${numbered}` },
      ],
      jsonMode: true,
      maxTokens: 900,
      trace,
      label: 'claim-check',
    });
    for (const v of JSON.parse(message.content ?? '{}').verdicts ?? []) {
      const i = Number(v.n) - 1;
      if (i >= 0 && i < claims.length && v.supported === false) {
        out.set(i, {
          missing: String(v.missing ?? '').trim(),
          kind: v.kind === 'inference' ? 'inference' : 'fact',
        });
      }
    }
  } catch {
    // A failed check is not a failed answer. Reporting "unverified" as
    // "unsupported" would train the reader to ignore the warning.
  }
  return out;
}

/** Empty audit, for the paths where checking is off or there is nothing to check. */
const empty = (checked = 0, misquoted: string[] = []): ClaimAudit =>
  ({ checked, misquoted, unsupported: [], inferences: [], recovered: [], extraCitations: [], ok: !misquoted.length });

/**
 * Second look. Was the claim wrong, or was the passage simply not fetched?
 *
 * THIS IS THE WHOLE POINT OF THE PASS, and it took a wrong diagnosis to find.
 * The answer to "what does Darcy's letter say about Wickham" asserted that he
 * came back for the living after spending the money. Both the eval judge and the
 * first version of this audit called it unsupported, and it reads exactly like a
 * model completing a novel it has memorised.
 *
 * It is in the book. `pride_prejudice:35:7` says he "applied to me again by
 * letter for the presentation" with circumstances "exceedingly bad". Retrieval
 * had fetched 35:8 and 35:9, the two chunks immediately after it, and missed the
 * one that mattered.
 *
 * So a flag conflates two completely different failures: the model inventing a
 * fact, and the search missing a passage. Only a second search separates them,
 * and they want opposite fixes. Suppressing the claim would have made a correct
 * answer worse. See DECISIONS.md D-62.
 */
async function lookAgain(
  claims: ClaimVerdict[],
  already: Set<string>,
  trace?: Trace,
): Promise<Chunk[]> {
  const found = new Map<string, Chunk>();
  await Promise.all(
    claims.map(async (c) => {
      // The claim itself is the query. It is a sentence about the books, which
      // is the shape retrieval handles best.
      const hits = await retrieve({ query: c.claim, k: 4, trace });
      for (const h of hits) if (!already.has(h.chunk.id)) found.set(h.chunk.id, h.chunk);
    }),
  );
  return [...found.values()];
}

export async function auditClaims(
  answer: string,
  retrieved: Chunk[],
  trace?: Trace,
): Promise<ClaimAudit> {
  if (!config.claimCheck) return empty();

  // Free, deterministic, and independent of everything below.
  // The whole corpus decides whether a quotation is real; the retrieved set only
  // decides whether it came from this question's evidence. See quotes.ts.
  // Chapters, not chunks: a quotation crossing a chunk seam is in no single
  // chunk, and only the overlap was hiding it (D-86).
  const quotes = checkQuotes(answer, retrieved, store.chapterCorpus());

  const byId = new Map(retrieved.map((c) => [c.id, c]));
  const claims = claimsOf(answer, byId);
  if (!claims.length) return empty(0, quotes.misquoted);

  // First pass: against what the question actually retrieved.
  const flagged = await judge(claims.map((c) => c.text), retrieved, trace);
  const all: ClaimVerdict[] = [...flagged.entries()].map(([i, f]) => ({
    claim: claims[i].text,
    supported: false,
    kind: f.kind,
    missing: f.missing,
    cited: claims[i].cited,
  }));
  if (!all.length) return empty(claims.length, quotes.misquoted);

  // Inference is separated here and goes no further. Searching the books for
  // evidence that one novel is "more controlled structurally" would find
  // passages that look topical and settle nothing, and a second judgement on
  // them would be theatre. It is marked as the assistant's own reading (D-63).
  const inferences = all.filter((v) => v.kind === 'inference');
  const factual = all.filter((v) => v.kind === 'fact');
  if (!factual.length) {
    return {
      checked: claims.length, misquoted: quotes.misquoted, unsupported: [], inferences,
      recovered: [], extraCitations: [], ok: !quotes.misquoted.length,
    };
  }

  // Second pass: search for each factual flag before calling it an addition.
  const already = new Set(retrieved.map((c) => c.id));
  const passages = await lookAgain(factual, already, trace);
  if (!passages.length) {
    return {
      checked: claims.length, misquoted: quotes.misquoted, unsupported: factual, inferences,
      recovered: [], extraCitations: [], ok: false,
    };
  }

  const stillFlagged = await judge(factual.map((v) => v.claim), passages, trace);
  const recovered = factual.filter((_, i) => !stillFlagged.has(i));
  const unsupported = factual
    .map((v, i) => (stillFlagged.has(i) ? { ...v, missing: stillFlagged.get(i)!.missing } : null))
    .filter((v): v is ClaimVerdict => v !== null);

  return {
    checked: claims.length,
    misquoted: quotes.misquoted,
    unsupported,
    inferences,
    recovered,
    // Only worth showing if they rescued something.
    extraCitations: recovered.length ? passages : [],
    ok: unsupported.length === 0 && quotes.misquoted.length === 0,
  };
}
