import { config } from '../config.js';
import type { Section } from './parse.js';

/**
 * Chapter-aware, paragraph-boundary chunking.
 *
 * Two rules, both load-bearing:
 *   1. A chunk never crosses a chapter boundary. A retrieved passage can then
 *      always be cited as "Book, Chapter N", which is what an editor needs.
 *   2. A chunk never splits a paragraph. Narrative prose carries meaning at
 *      paragraph granularity; a fixed character window truncates mid-sentence
 *      and produces passages that read as broken when shown in the UI.
 *
 * See DECISIONS.md D-03 for sizing.
 */

export interface Chunk {
  id: string;
  bookId: string;
  bookTitle: string;
  author: string;
  chapterIndex: number;
  chapterTitle: string;
  chunkIndex: number;   // position within the chapter
  text: string;
  wordCount: number;
}

/**
 * Titles and honorifics that end in a period and must not be treated as a
 * sentence boundary. "Mr. Darcy" splitting into two sentences would be a
 * frequent, silent corruption in both of these books.
 */
const ABBREV =
  // The leading class must allow an opening quote or bracket. Without it,
  // `concludes that "Mr. Wickham's object...` split after `"Mr.`, because the
  // character before the honorific was a quotation mark rather than a space.
  // Both books open dialogue with a title constantly, so this fired often.
  /(?:^|[\s("'\u201C\u2018\[])(?:Mr|Mrs|Ms|Dr|St|Jr|Sr|Prof|Rev|Hon|Capt|Col|Gen|Lt|Sgt|Esq|vs|etc|No|i\.e|e\.g)\.$/i;

export function splitSentences(text: string): string[] {
  // The closer class allows several, and includes the curly right single quote.
  // With a single optional closer and no `’`, a sentence ending inside nested
  // quotation ("...so proud!’”) never split, so the next sentence was glued to
  // the end of the quote. The reader saw it in the claim audit: a flagged
  // statement that began mid-quotation and read as nonsense (D-89).
  const parts = text.split(/(?<=[.!?][”’"')\]]{0,3})\s+/);
  const out: string[] = [];
  for (const part of parts) {
    const prev = out[out.length - 1];
    if (prev !== undefined && ABBREV.test(prev)) out[out.length - 1] = `${prev} ${part}`;
    else out.push(part);
  }
  return out;
}

/**
 * Gutenberg renders long epistolary passages as a single <p>. Darcy's letter in
 * Pride & Prejudice ch. XXXV is 2,480 words in one paragraph; Mrs Gardiner's in
 * ch. LII is 1,786. Left alone these become single chunks ~7x the target, which
 * dilutes the embedding and makes any citation uselessly coarse. Paragraphs over
 * the target are therefore split on sentence boundaries. See DECISIONS.md D-04.
 */
function explodeParagraph(para: string, targetWords: number): string[] {
  if (countWords(para) <= targetWords) return [para];
  const out: string[] = [];
  let buf: string[] = [];
  let words = 0;
  for (const sentence of splitSentences(para)) {
    const w = countWords(sentence);
    if (words + w > targetWords && words > 0) {
      out.push(buf.join(' '));
      buf = [];
      words = 0;
    }
    buf.push(sentence);
    words += w;
  }
  if (buf.length) out.push(buf.join(' '));
  return out;
}

export function chunkSections(
  sections: Section[],
  book: { id: string; title: string; author: string },
): Chunk[] {
  const { targetWords, overlapWords } = config.chunk;
  const chunks: Chunk[] = [];

  for (const section of sections) {
    let buffer: string[] = [];
    let bufferWords = 0;
    let chunkIndex = 0;

    const flush = () => {
      if (!buffer.length) return;
      const text = buffer.join('\n\n');
      chunks.push({
        id: `${book.id}:${section.index}:${chunkIndex}`,
        bookId: book.id,
        bookTitle: book.title,
        author: book.author,
        chapterIndex: section.index,
        chapterTitle: section.title,
        chunkIndex,
        text,
        wordCount: bufferWords,
      });
      chunkIndex++;

      // Carry the tail of this chunk into the next one so a passage spanning a
      // chunk boundary is still retrievable from at least one side.
      //
      // The carry is sentence-granular, not paragraph-granular. Carrying whole
      // paragraphs meant a 300-word closing paragraph became the seed of the
      // next chunk and pushed it to ~650 words. The overlap silently undid the
      // size target it was meant to support.
      const sentences = splitSentences(text);
      const carried: string[] = [];
      let carriedWords = 0;
      for (let i = sentences.length - 1; i >= 0 && carriedWords < overlapWords; i--) {
        carried.unshift(sentences[i]);
        carriedWords += countWords(sentences[i]);
      }
      // Guard against a single sentence longer than half the target seeding
      // every subsequent chunk.
      if (carriedWords > targetWords / 2) {
        buffer = [];
        bufferWords = 0;
      } else {
        buffer = [carried.join(' ')];
        bufferWords = carriedWords;
      }
    };

    const units = section.paragraphs.flatMap((p) => explodeParagraph(p, targetWords));
    for (const unit of units) {
      const w = countWords(unit);
      if (bufferWords + w > targetWords && bufferWords > 0) flush();
      buffer.push(unit);
      bufferWords += w;
    }
    flush();
  }

  return chunks;
}

const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
