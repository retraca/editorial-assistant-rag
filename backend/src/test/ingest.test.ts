import test from 'node:test';
import assert from 'node:assert/strict';

import { parseBook } from '../ingest/parse.js';
import { strengthOf, relationshipInWords } from '../retrieval/similar.js';
import { Trace } from '../trace.js';

/**
 * The parse layer, the translation layer, and the cost accounting.
 *
 * These three were the largest untested surfaces left after the first test pass,
 * and each one has produced a user-visible defect:
 *
 *   parse.ts     decapitated every chapter that opened with a drop cap, and read
 *                "CHAPTERXXVIII" as one word
 *   similar.ts   is the boundary where an internal number becomes a sentence an
 *                editor can act on. If it leaks, the reader sees 0.6487
 *   trace.ts     is the only thing that makes cost visible, and cached tokens
 *                are billed differently
 *
 * See DECISIONS.md D-54 for why these sit beside the eval rather than inside it.
 */

/* ─────────────────────── parsing Gutenberg HTML ─────────────────────── */

const page = (body: string) => `<html><body>${body}</body></html>`;

/** Sections below a word floor are dropped as front matter, so fixtures pad. */
const pad = ' The remainder of the chapter continues at ordinary length.'.repeat(30);

test('a drop cap carried in image alt text is recovered, not dropped', () => {
  // Gutenberg renders the opening letter as <img alt="N">. Stripping images
  // without recovering the alt silently beheads the chapter: "OT all that Mrs.
  // Bennet, however..." instead of "NOT all that...".
  const html = page(`
    <h2>CHAPTER III.</h2>
    <p class="nind"><span class="letra"><img alt="N" src="i_039_b.png"></span>OT all that Mrs.
    Bennet, however, could ask on the subject was sufficient.${pad}</p>`);
  const [chapter] = parseBook(html);
  assert.match(chapter.paragraphs[0], /^NOT all that Mrs\./);
});

test('an image with no single-letter alt is still stripped', () => {
  const html = page(`
    <h2>CHAPTER I.</h2>
    <p><img alt="decorative border" src="border.png">The text begins here.${pad}</p>`);
  const [chapter] = parseBook(html);
  assert.ok(!chapter.paragraphs[0].includes('decorative'),
    'a caption is not part of the prose');
  assert.match(chapter.paragraphs[0], /The text begins here/);
});

test('a heading whose space was lost is restored', () => {
  // "CHAPTERXXVIII" appears in the source. Left alone it breaks the chapter
  // reference shown beside every citation.
  const [chapter] = parseBook(page(`<h2>CHAPTERXXVIII.</h2><p>Some prose.${pad}</p>`));
  assert.match(chapter.title, /CHAPTER XXVIII/);
});

test('chapters are segmented at h2 and numbered in document order', () => {
  const html = page(`
    <h2>CHAPTER I.</h2><p>First.${pad}</p>
    <h2>CHAPTER II.</h2><p>Second.${pad}</p>
    <h2>CHAPTER III.</h2><p>Third.${pad}</p>`);
  const chapters = parseBook(html);
  assert.equal(chapters.length, 3);
  assert.deepEqual(chapters.map((c) => c.index), [0, 1, 2]);
  assert.deepEqual(chapters.map((c) => c.paragraphs[0].split('.')[0]), ['First', 'Second', 'Third']);
});

test('each chapter carries its own word count', () => {
  const [chapter] = parseBook(page(`<h2>CHAPTER I.</h2><p>One two three four five.${pad}</p>`));
  assert.equal(chapter.wordCount, chapter.paragraphs.join(' ').split(/\s+/).length);
});

test('matter too short to be a chapter is dropped', () => {
  // A title page or a two-line preface is not a chapter, and shipping it as one
  // put "Untitled section" in the reader's chapter list.
  const chapters = parseBook(page(`
    <h2>PREFACE</h2><p>Two lines only.</p>
    <h2>CHAPTER I.</h2><p>Real chapter.${pad}</p>`));
  assert.equal(chapters.length, 1);
  assert.match(chapters[0].title, /CHAPTER I/);
});

/* ─────────────────────── translation at the boundary ─────────────────────── */

test('similarity becomes a sentence, and never a number', () => {
  // D-33 and D-35: an editor cannot act on 0.6487. Every one of these is what
  // the reader actually sees, so none of them may contain a digit.
  const baseline = 0.4316;
  const said = [0.44, 0.50, 0.60, 0.72].map((s) => strengthOf(s, baseline));
  for (const phrase of said) {
    assert.ok(!/\d/.test(phrase), `leaked a number to the reader: "${phrase}"`);
    assert.ok(phrase.length > 12, 'a bare label is not an explanation');
  }
  assert.equal(new Set(said).size, said.length, 'each band should read differently');
});

test('a pair at the baseline is described as unremarkable', () => {
  const phrase = strengthOf(0.4316, 0.4316);
  assert.match(phrase, /random/,
    'two passages no closer than chance must be reported as such, not as a weak signal');
});

test('internal category names never reach the reader', () => {
  const internal = ['parallel_scene', 'shared_theme', 'similar_phrasing', 'coincidental'];
  for (const rel of internal) {
    const words = relationshipInWords(rel);
    assert.ok(!words.includes('_'), `leaked the internal name for ${rel}`);
    assert.notEqual(words, rel);
  }
});

test('an unrecognised or missing relationship degrades to plain words', () => {
  assert.ok(!relationshipInWords(undefined).includes('undefined'));
  assert.ok(!relationshipInWords('some_new_label').includes('_'));
});

/* ─────────────────────── cost and timing ─────────────────────── */

test('a trace accumulates spans in order with durations', async () => {
  const t = new Trace();
  await t.span('one', async () => 1);
  await t.span('two', async () => 2);
  const s = t.summary();
  assert.deepEqual(s.spans.map((x) => x.name), ['one', 'two']);
  assert.ok(s.spans.every((x) => typeof x.ms === 'number' && x.ms >= 0));
});

test('a span returns its callback value and still records on throw', async () => {
  const t = new Trace();
  assert.equal(await t.span('ok', async () => 'value'), 'value');
  await assert.rejects(() => t.span('boom', async () => { throw new Error('x'); }));
  assert.ok(t.summary().spans.some((s) => s.name === 'boom'),
    'a failed stage still costs time and must appear in the trace');
});

test('cached prompt tokens are charged at the cached rate', () => {
  // The provider bills them at a fraction. Charging full rate would overstate
  // cost, and the whole point of showing cost is that it is roughly right.
  const full = new Trace();
  full.addUsage({ promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 0 });
  const cached = new Trace();
  cached.addUsage({ promptTokens: 1000, completionTokens: 0, cachedPromptTokens: 1000 });
  assert.ok(cached.summary().estimatedCostUsd < full.summary().estimatedCostUsd,
    'a fully cached prompt must cost less than an uncached one');
});

test('an empty trace costs nothing and reports no spans', () => {
  const s = new Trace().summary();
  assert.equal(s.estimatedCostUsd, 0);
  assert.deepEqual(s.spans, []);
});

/**
 * A chapter is read from the book, not rebuilt from the search index.
 *
 * This is the regression guard for D-85. chapterText used to reassemble a
 * chapter from its overlapping chunks and strip the repeats by deduplicating
 * sentences, which deleted real text: every genuinely repeated sentence, and
 * "Mrs." wherever a local sentence splitter had made the honorific a sentence
 * of its own. The reader was shown "March was both surprised" where the book
 * says "Mrs. March was both surprised", in 45 chapters, silently.
 *
 * The invariant is the strongest one available: what the reader sees is what
 * the parser produced, character for character, apart from the title echo.
 */
test('every chapter reads exactly as the book, not as a reconstruction', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { store } = await import('../retrieval/store.js');
  const { config, BOOKS } = await import('../config.js');
  if (!fs.existsSync(path.join(config.paths.index, 'chunks.json'))) return; // no index in CI

  store.load();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  for (const b of BOOKS) {
    for (const sec of parseBook(fs.readFileSync(path.join(config.paths.books, b.file), 'utf8'))) {
      let truth = norm(sec.paragraphs.join(' '));
      const got = norm(store.chapterText(b.id, sec.index));
      const start = truth.indexOf(got.slice(0, 40)); // the title echo is dropped on purpose
      if (start > 0) truth = truth.slice(start);
      assert.equal(got, truth, `${b.id}:${sec.index} does not match the parsed chapter`);
    }
  }
});

test('a repeated line and an honorific both survive being read', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { store } = await import('../retrieval/store.js');
  const { config } = await import('../config.js');
  if (!fs.existsSync(path.join(config.paths.index, 'chunks.json'))) return;

  store.load();
  const has = (b: string, i: number, s: string) =>
    store.chapterText(b, i).replace(/\s+/g, ' ').includes(s);
  assert.ok(has('little_women', 10, 'O Pip! O Pip!'), 'a deliberate repetition was deduplicated away');
  assert.ok(has('little_women', 9, 'P. C.'), 'an abbreviation was deduplicated away');
  assert.ok(has('pride_prejudice', 22, 'Engaged to Mr. Collins!'), 'an honorific was deduplicated away');
});
