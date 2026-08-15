import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { dot } from '../azure.js';
import type { Chunk } from '../ingest/chunk.js';
import { parseBook, isNumberedChapter } from '../ingest/parse.js';
import { BOOKS } from '../config.js';

/**
 * In-memory chunk + vector store.
 *
 * 1,359 chunks x 1,024 dims = ~1.4M floats (5.3 MB). A brute-force scan is a
 * few milliseconds, so there is no vector database here on purpose, see
 * DECISIONS.md D-05.
 *
 * Vectors live in one contiguous Float32Array rather than an array of arrays:
 * one allocation, and the scan walks memory linearly.
 */

export interface Scored {
  chunk: Chunk;
  score: number;
}

class Store {
  chunks: Chunk[] = [];
  dims = 0;
  /**
   * Facts about the collection itself, how long each book is, how many
   * chapters it has. Computed at boot by re-parsing the source, because summing
   * chunk word counts would double-count the overlap between chunks.
   */
  stats: Record<string, { words: number; chapters: number; chunks: number }> = {};
  /** The parsed books, kept so a chapter can be read from the source rather
   *  than reassembled from overlapping chunks. See chapterText. */
  private sections: Record<string, { index: number; title: string; paragraphs: string[] }[]> = {};
  private chapterCache: Chunk[] | null = null;
  private notesCache: any = null;
  private notesTried = false;
  private matrix = new Float32Array(0);
  private byId = new Map<string, number>();
  builtAt = '';

  load() {
    const metaPath = path.join(config.paths.index, 'chunks.json');
    const vecPath = path.join(config.paths.index, 'vectors.f32');
    if (!fs.existsSync(metaPath) || !fs.existsSync(vecPath)) {
      throw new Error('Index not found. Run `npm run ingest` first.');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    this.chunks = meta.chunks;
    this.chapterCache = null;
    this.dims = meta.dims;
    this.builtAt = meta.builtAt;

    const buf = fs.readFileSync(vecPath);
    this.matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (this.matrix.length !== this.chunks.length * this.dims) {
      throw new Error('Index corrupt: vector count does not match chunk count. Re-run `npm run ingest`.');
    }
    if (this.dims !== config.embeddingDims) {
      throw new Error(
        `Index built at ${this.dims}d but EMBEDDING_DIMS=${config.embeddingDims}. Re-run \`npm run ingest\`.`,
      );
    }
    this.chunks.forEach((c, i) => this.byId.set(c.id, i));

    for (const b of BOOKS) {
      // parseBook now returns only the work itself, so no filter here. It used
      // to filter at this line alone, which fixed the chapter COUNT the app
      // displayed and left the same sections fully searchable (D-84).
      const real = parseBook(fs.readFileSync(path.join(config.paths.books, b.file), 'utf8'));
      this.sections[b.id] = real;
      this.stats[b.id] = {
        words: real.reduce((n, s) => n + s.wordCount, 0),
        chapters: real.length,
        chunks: this.chunks.filter((c) => c.bookId === b.id).length,
      };
    }
    return this;
  }

  /**
   * Append chunks + vectors in memory only. Used by the needle-in-a-haystack
   * eval to plant synthetic passages into the corpus without rebuilding or
   * mutating the on-disk index. Nothing here is persisted.
   */
  append(chunks: Chunk[], vectors: Float32Array[]) {
    if (chunks.length !== vectors.length) throw new Error('chunks/vectors length mismatch');
    const grown = new Float32Array(this.matrix.length + vectors.length * this.dims);
    grown.set(this.matrix, 0);
    vectors.forEach((v, i) => grown.set(v, this.matrix.length + i * this.dims));
    this.matrix = grown;
    for (const c of chunks) {
      this.byId.set(c.id, this.chunks.length);
      this.chunks.push(c);
    }
  }

  vectorAt(i: number): Float32Array {
    return this.matrix.subarray(i * this.dims, (i + 1) * this.dims);
  }

  get(id: string): Chunk | undefined {
    const i = this.byId.get(id);
    return i === undefined ? undefined : this.chunks[i];
  }

  indexOf(id: string): number | undefined {
    return this.byId.get(id);
  }

  /**
   * Cosine similarity via dot product, vectors are L2-normalised at write
   * time, so no per-comparison division is needed.
   */
  dense(query: Float32Array, k: number, filter?: (c: Chunk) => boolean): Scored[] {
    const out: Scored[] = [];
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (filter && !filter(chunk)) continue;
      out.push({ chunk, score: dot(query, this.vectorAt(i)) });
    }
    return topK(out, k);
  }

  /** Chapter text, reassembled from its chunks (overlap removed by dedupe). */
  chapter(bookId: string, chapterIndex: number): Chunk[] {
    return this.chunks
      .filter((c) => c.bookId === bookId && c.chapterIndex === chapterIndex)
      .sort((a, b) => a.chunkIndex - b.chunkIndex);
  }

  /**
   * A chapter, as it is in the book.
   *
   * This used to reassemble the chapter from its chunks and remove the overlap
   * by deduplicating sentences. That is a reconstruction, and it was quietly
   * wrong (D-85): a chapter-wide dedup deleted every repeated sentence rather
   * than the overlap, and a local sentence splitter treated "Mrs." as a sentence
   * of its own and then deduplicated it, so 45 chapters showed the reader
   * "March was both surprised" where Alcott wrote "Mrs. March was both
   * surprised". Tightening the dedup got it to 3 chapters wrong, two of them by
   * repeating text instead of losing it.
   *
   * There is no reason to reconstruct. The books are parsed at boot for the
   * collection stats, so the chapter is already in memory, exactly. Chunking is
   * how the corpus is SEARCHED; it is not how it should be READ. The whole class
   * of bug disappears with the reconstruction that caused it.
   *
   * The title echo is still dropped: Gutenberg repeats the chapter number and
   * title as the first body paragraphs and the heading already carries them.
   */
  chapterText(bookId: string, chapterIndex: number): string {
    const sec = this.sections[bookId]?.find((x) => x.index === chapterIndex);
    if (!sec) return '';
    const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const titleKey = key(sec.title);
    const isTitleEcho = (t: string) => {
      const k = key(t);
      return k.length > 0 && k.length < 60 && (titleKey.includes(k) || k.includes(titleKey));
    };
    const paras = [...sec.paragraphs];
    while (paras.length && isTitleEcho(paras[0])) paras.shift();
    return paras.join('\n\n');
  }

  /**
   * The chapter notes, read once and cached.
   *
   * `summarise` is a separate offline pass and its output may be absent, which
   * is a normal state rather than an error: the tools and the API both say so
   * instead of failing. This lived twice, once in server.ts and once in
   * tools.ts, each with its own module-level cache and its own tried-flag. Two
   * copies of a loader is how D-85 happened, so there is one.
   */
  notes(): any {
    if (!this.notesTried) {
      this.notesTried = true;
      try {
        this.notesCache = JSON.parse(
          fs.readFileSync(path.join(config.paths.index, '..', 'summaries.json'), 'utf8'),
        );
      } catch {
        this.notesCache = null;
      }
    }
    return this.notesCache;
  }

  /**
   * The corpus as continuous chapters, for anything asking "is this text real".
   *
   * The quotation check used to take `store.chunks`, so its haystack was the
   * chunking, and a quotation crossing a chunk seam was in no single entry. It
   * did not misfire only because the 60 words of overlap happen to carry the
   * seam: measured across 545 straddling spans, 545 were found solely in the
   * following chunk. That is a silent dependency between a guardrail and a
   * chunking parameter the README invites the reader to set to zero (D-56), and
   * flipping it would have made the check report real prose as misquoted.
   *
   * A quotation can never span a chapter, because a chunk never does. So the
   * chapter is the right unit, and the check no longer depends on how the text
   * was cut up for search (D-86).
   */
  chapterCorpus(): Chunk[] {
    if (this.chapterCache) return this.chapterCache;
    const seen = new Set<string>();
    const out: Chunk[] = [];
    for (const c of this.chunks) {
      const k = `${c.bookId}:${c.chapterIndex}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // The heading is part of the book, and the reader can legitimately quote
      // it: "it appears in XXIII. Aunt March settles the Question". chapterText
      // drops the title echo on purpose so the reader is not shown it twice, so
      // it is added back HERE, where the question is only "is this real text
      // from these books". Without it, quoting a chapter name was reported as a
      // misquotation (D-96).
      const title = c.chapterTitle ?? '';
      out.push({
        ...c, id: k, chunkIndex: 0,
        text: `${title}\n\n${this.chapterText(c.bookId, c.chapterIndex)}`,
      });
    }
    this.chapterCache = out;
    return out;
  }

  /**
   * Front and back matter is not a chapter.
   *
   * Gutenberg wraps the work in material that survives the word-count filter:
   * "Transcriber's Notes", and in Little Women a publisher's catalogue titled
   * "The Works of Louisa May Alcott". Both were listed in the Library as
   * chapters, both were summarised at ingest, and both were searchable, so a
   * question about the books could be answered from a 1868 advertisement.
   *
   * The rule is structural rather than a list of titles, per D-02: every real
   * chapter in a numbered book carries a numeral, and these carry none. It only
   * applies when the book is numbered at all, so an unnumbered work does not
   * lose every section.
   *
   * Now enforced at parse time as well, so these sections never reach the index
   * (D-84). This stays as the read-side guard for an index built before that
   * change, and is what the interface uses to decide whether a title is a
   * chapter it can offer to open.
   */
  isChapter(bookId: string, title: string): boolean {
    const titles = [...new Set(this.chunks.filter((c) => c.bookId === bookId).map((c) => c.chapterTitle))];
    return isNumberedChapter(title, titles);
  }

  chapters(bookId: string) {
    const seen = new Map<number, string>();
    for (const c of this.chunks) {
      if (c.bookId === bookId && !seen.has(c.chapterIndex)) seen.set(c.chapterIndex, c.chapterTitle);
    }
    return [...seen.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, title]) => this.isChapter(bookId, title))
      .map(([index, title]) => ({ index, title }));
  }
}

/**
 * Structural test, not a list of titles (D-02): every chapter in a numbered work
 * carries a numeral, and front and back matter does not. Applied only when the
 * work is numbered at all, so an unnumbered book keeps every section.
 */
export function topK<T extends { score: number }>(items: T[], k: number): T[] {
  return items.sort((a, b) => b.score - a.score).slice(0, k);
}

export const store = new Store();
