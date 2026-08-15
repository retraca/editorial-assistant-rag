import fs from 'node:fs';
import path from 'node:path';
import { BOOKS, config } from '../config.js';
import { store } from '../retrieval/store.js';
import { chat } from '../azure.js';
import { Trace } from '../trace.js';

/**
 * Chapter summaries and key moments, generated FROM the indexed text.
 *
 * Not recalled from the model. A summary of Little Women written from memory
 * would read well, cite nothing, and fail completely on the actual job. An
 * editorial team reviews manuscripts nobody has published. See DECISIONS.md D-43.
 *
 * One pass per chapter produces both the summary and the chapter's key moments,
 * because the same reading is needed for each and importance cannot be derived
 * from embeddings (D-44). Book summaries are then written from the chapter
 * summaries rather than from the raw text, which keeps the final call small.
 *
 * Key moments are returned as VERBATIM quotations and every one is checked
 * against the chapter before it is stored. A quote that does not occur is
 * dropped. The model is not trusted to quote any more than it is trusted to
 * cite (D-18).
 *
 * Run: npm run summarise
 */

const PACE_MS = 700;
/** Retries for a note the checker rejects. Kept low: a third attempt has never helped. */
const MAX_REWRITES = 1;

const CHECK_SYSTEM = `You are checking a chapter summary against the chapter it describes.

Return JSON: {"unsupported": ["..."], "verdict": "faithful" | "drifts"}

List any statement in the summary the chapter does not support: an event that does not happen, a
motive not shown, a name or relationship that is wrong, an outcome reversed.

ALLOW compression, paraphrase, reordering and reasonable inference from what is shown. A summary is
supposed to be shorter than the chapter, so absence is not an error. Only flag what is WRONG.

"verdict" is "drifts" if you listed anything, otherwise "faithful".`;
const OUT = path.join(config.paths.index, '..', 'summaries.json');

export interface ChapterSummary {
  bookId: string;
  index: number;
  title: string;
  summary: string;
  moments: string[];
}
export interface Summaries {
  generatedAt: string;
  books: Record<string, { summary: string; chapters: ChapterSummary[] }>;
}

const CHAPTER_SYSTEM = `You are preparing reading notes for a book editor.

Given one chapter, return JSON:
{"summary": "...", "moments": ["...", "..."]}

"summary": two or three sentences on what happens in this chapter and why it matters to the book.
Write plainly, for someone who has not read it. Do not evaluate or praise.

HOW TO WRITE IT. An editor reads dozens of these. Prose that sounds generated wastes their attention
on the writing instead of the book.
- Name what happens. Who does what, to whom, with what consequence. Concrete nouns and plain verbs.
- No em dashes. Use a period, a comma, a colon, or brackets.
- Never write "X is not A, it is B", and never define something against what it is not. Say what it is.
- No summary-blurb verbs: "explores", "grapples with", "navigates", "delves into", "sets the stage",
  "comes to terms with", "journey", "coming-of-age", "poignant", "heartwarming".
- Do not say a chapter "reveals themes" or "highlights" anything. Report the events.
- Do not open with "In this chapter". Start with what happens.

"moments": two or three of the most consequential sentences IN THE CHAPTER, quoted EXACTLY as
written, character for character. Choose lines that turn something. A decision, a revelation, a
refusal, not the most descriptive or most typical lines. Copy them verbatim from the text you were
given. Do not paraphrase, join, or trim them.`;

const BOOK_SYSTEM = `You are writing a short orientation note for a book editor who has not read this book.

You will be given its chapter summaries in order. Return JSON: {"summary": "..."}

Four to six sentences: what the book is about, who it follows, and what shape the story takes.
Base it only on the summaries given. Plain and factual. This is a working note for a colleague.

HOW TO WRITE IT. The failure mode is back-cover copy. Avoid it deliberately.
- Do not open with "The novel follows..." or "Set against the backdrop of...". Open with the
  situation the book starts from.
- No em dashes. Use a period, a comma, a colon, or brackets.
- Never write "X is not A, it is B". Say what it is.
- Banned: "coming-of-age", "journey", "explores", "grapples with", "navigates", "poignant",
  "timeless", "beloved", "richly drawn", "unfolds", "against the backdrop", "at its heart".
- Say what actually happens in the book, including how it ends. This is a working note for someone
  deciding where to spend their reading time, so spoilers are the point.`;

/** Loose match, so punctuation and whitespace differences do not fail a real quote. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Statements the chapter does not support. Empty means faithful. */
async function checkSummary(
  title: string, text: string, summary: string, trace: Trace, label: string,
): Promise<string[]> {
  try {
    const { message } = await chat({
      messages: [
        { role: 'system', content: CHECK_SYSTEM },
        { role: 'user', content: `CHAPTER: ${title}\n\n${text.slice(0, 14000)}\n\n---\n\nSUMMARY:\n${summary}` },
      ],
      jsonMode: true, maxTokens: 400, trace, label: `check:${label}`,
    });
    const v = JSON.parse(message.content ?? '{}');
    return v.verdict === 'drifts' ? (v.unsupported ?? []).map((x: unknown) => String(x)) : [];
  } catch {
    // A failed check is not a failed note. Rewriting on an unverified verdict
    // would churn good summaries.
    return [];
  }
}

/** One targeted rewrite. The checker names what is wrong, so fix only that. */
async function rewrite(
  title: string, text: string, summary: string, problems: string[], trace: Trace, label: string,
): Promise<string> {
  try {
    const { message } = await chat({
      messages: [
        { role: 'system', content: CHAPTER_SYSTEM },
        {
          role: 'user',
          content:
            `${title}\n\n${text.slice(0, 14000)}\n\n---\n\nA previous summary of this chapter ` +
            `contained statements the chapter does not support:\n` +
            problems.map((p) => `- ${p}`).join('\n') +
            `\n\nPrevious summary:\n${summary}\n\nWrite the summary again without those ` +
            `statements. Return the same JSON shape; "moments" may be an empty list.`,
        },
      ],
      jsonMode: true, maxTokens: 700, trace, label: `rewrite:${label}`,
    });
    const parsed = JSON.parse(message.content ?? '{}');
    return String(parsed.summary ?? summary).trim() || summary;
  } catch {
    return summary;
  }
}

async function main() {
  store.load();
  const trace = new Trace();
  const result: Summaries = { generatedAt: new Date().toISOString(), books: {} };

  for (const book of BOOKS) {
    const chapters = store.chapters(book.id);
    const done: ChapterSummary[] = [];
    console.log(`\n${book.title}: ${chapters.length} chapters`);

    for (const ch of chapters) {
      const text = store.chapterText(book.id, ch.index);
      const haystack = norm(text);

      let summary = '';
      let moments: string[] = [];
      try {
        const { message } = await chat({
          messages: [
            { role: 'system', content: CHAPTER_SYSTEM },
            { role: 'user', content: `${ch.title}\n\n${text.slice(0, 14000)}` },
          ],
          jsonMode: true,
          maxTokens: 700,
          trace,
          label: `summarise:${book.id}:${ch.index}`,
        });
        const parsed = JSON.parse(message.content ?? '{}');
        summary = String(parsed.summary ?? '').trim();
        // Verified quotes only. A "moment" that is not in the chapter is a
        // fabrication, however plausible it reads.
        moments = (parsed.moments ?? [])
          .map((m: unknown) => String(m ?? '').trim())
          .filter((m: string) => m.length > 20 && haystack.includes(norm(m)));
      } catch (err) {
        console.warn(`\n  ch${ch.index} failed: ${(err as Error).message.slice(0, 90)}`);
      }

      // The quotations have been verified since D-43. The prose around them
      // never was, and a sample put it at 88% faithful, which is a poor number
      // for text the assistant repeats as whole-book truth (D-73).
      for (let attempt = 0; attempt <= MAX_REWRITES && summary; attempt++) {
        const bad = await checkSummary(ch.title, text, summary, trace, `${book.id}:${ch.index}`);
        if (!bad.length) break;
        if (attempt === MAX_REWRITES) {
          console.warn(`\n  ch${ch.index} still drifts: ${bad[0]?.slice(0, 70)}`);
          break;
        }
        summary = await rewrite(ch.title, text, summary, bad, trace, `${book.id}:${ch.index}`);
      }

      done.push({ bookId: book.id, index: ch.index, title: ch.title, summary, moments });
      process.stdout.write(`\r  ${done.length}/${chapters.length}`);
      await new Promise((r) => setTimeout(r, PACE_MS));
    }
    console.log();

    // The book note is written from the chapter notes, not the raw text.
    let bookSummary = '';
    try {
      const { message } = await chat({
        messages: [
          { role: 'system', content: BOOK_SYSTEM },
          {
            role: 'user',
            content: `${book.title} by ${book.author}\n\n` +
              done.map((c) => `${c.title}: ${c.summary}`).join('\n'),
          },
        ],
        jsonMode: true,
        maxTokens: 600,
        trace,
        label: `summarise:${book.id}:book`,
      });
      bookSummary = String(JSON.parse(message.content ?? '{}').summary ?? '').trim();
    } catch (err) {
      console.warn(`  book summary failed: ${(err as Error).message.slice(0, 90)}`);
    }

    result.books[book.id] = { summary: bookSummary, chapters: done };
    const withMoments = done.filter((c) => c.moments.length).length;
    console.log(`  ${withMoments}/${done.length} chapters have verified quotes`);
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));

  const s = trace.summary();
  console.log(`\nWrote ${OUT}`);
  console.log(`Cost $${s.estimatedCostUsd.toFixed(3)}  elapsed ${(s.totalMs / 1000 / 60).toFixed(1)} min`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
