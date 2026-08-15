import test from 'node:test';
import assert from 'node:assert/strict';

import { checkQuotes } from '../agent/quotes.js';
import type { Chunk } from '../ingest/chunk.js';

/**
 * The verbatim quotation check.
 *
 * Free and deterministic, which is the point: a quotation is the one claim in an
 * answer decidable by string comparison, and the semantic judge demonstrably
 * misses these. It passed an answer quoting Aunt March on marrying a man "with
 * money, position, or business" where the book says "without", because
 * topically every piece of information was present. See DECISIONS.md D-64.
 */

const chunk = (id: string, text: string): Chunk => ({
  id, bookId: 'lw', bookTitle: 'Little Women', author: 'Alcott',
  chapterTitle: 'XXIII', chapterIndex: 23, chunkIndex: 0, text,
  wordCount: text.split(' ').length,
});

const SOURCE = [chunk('lw:23:0',
  'you are not to think of marrying a man without money, position, or business. ' +
  '“If you do, not one penny of my money ever goes to you,” said Aunt March, looking scandalized.')];

test('a quotation present in a passage passes', () => {
  const r = checkQuotes('She warns "not one penny of my money ever goes to you".', SOURCE);
  assert.equal(r.checked, 1);
  assert.deepEqual(r.misquoted, []);
});

test('a dropped negation is caught', () => {
  // The exact failure the LLM judge waved through. Reversing a quoted judgement
  // is the most damaging error an editorial tool can make.
  const r = checkQuotes('Aunt March objects to "marrying a man with money, position, or business".', SOURCE);
  assert.equal(r.misquoted.length, 1);
});

test('punctuation, curly quotes and case do not count as misquotes', () => {
  const r = checkQuotes(
    // The dash is written as an escape so this file does not fail the prose rule
    // it is not subject to: nineteenth-century novels are full of them.
    `She said "If you do \u2014 not one penny of my money ever goes to you!"`, SOURCE);
  assert.deepEqual(r.misquoted, [], 'differences the source introduced are not the writer’s error');
});

test('an ellipsis is checked on both sides of the omission', () => {
  // Both halves must clear MIN_WORDS to be checked at all, which is why the
  // fixture is long: a four-word fragment in quotes is emphasis, not a quotation.
  const ok = checkQuotes(
    '"you are not to think of marrying a man ... not one penny of my money ever goes to you"', SOURCE);
  assert.deepEqual(ok.misquoted, []);
  const bad = checkQuotes(
    '"you are not to think of marrying a man ... every penny of my fortune goes straight to you"', SOURCE);
  assert.equal(bad.misquoted.length, 1, 'a fabricated half must still fail');
});

test('a short phrase in quotation marks is emphasis, not a quotation', () => {
  // "domestic life and moral lessons" appeared in quotes in a real answer and
  // failed the whole case. Five words is a writer stressing a phrase.
  const r = checkQuotes('It is about "domestic life and moral lessons" throughout.', SOURCE);
  assert.equal(r.checked, 0);
  assert.equal(r.ok, true);
});

test('short spans are ignored, because scare quotes are not quotations', () => {
  const r = checkQuotes('The word "money" recurs, and so does "position".', SOURCE);
  assert.equal(r.checked, 0);
  assert.deepEqual(r.misquoted, []);
});

test('a quotation spanning two passages is accepted', () => {
  // Answers legitimately quote across adjacent retrieved passages.
  const split = [chunk('a:0:0', 'she resolved to speak plainly to her sister'),
                 chunk('a:0:1', 'and to say nothing of the letter at all')];
  const r = checkQuotes('"she resolved to speak plainly to her sister"', split);
  assert.deepEqual(r.misquoted, []);
});

test('an editorial bracket substituting a word is not a misquote', () => {
  // Standard scholarly practice: "persuaded [Georgiana] to believe" where the
  // source says "persuaded her to believe". The parts either side are verbatim.
  const src = [chunk('a:0:0', 'he persuaded her to believe herself in love and to consent to an elopement')];
  const r = checkQuotes('Darcy says he "persuaded [Georgiana] to believe herself in love".', src);
  assert.deepEqual(r.misquoted, []);
});

test('a nested quotation does not break the match', () => {
  const src = [chunk('a:0:0', 'the little demon said in her ear, "No matter whether she heard or not"')];
  const r = checkQuotes('The narrator writes: “said in her ear, ‘No matter whether she heard or not’”.', src);
  assert.deepEqual(r.misquoted, []);
});

test('nothing retrieved means every quotation is a misquote', () => {
  const r = checkQuotes('He said "not one penny of my money ever goes to you".', []);
  assert.equal(r.misquoted.length, 1);
  assert.equal(r.ok, false);
});

test('real book text the search did not return is not a misquote', () => {
  // An answer written from the chapter notes cites no passages at all, so
  // checking only against the retrieved set reported verbatim Alcott as
  // fabricated. The corpus decides what is real; the retrieved set decides only
  // where it came from.
  const r = checkQuotes('She warns "not one penny of my money ever goes to you".', [], SOURCE);
  assert.deepEqual(r.misquoted, [], 'present in the books, so not a fabrication');
  assert.equal(r.unretrieved.length, 1, 'but worth reporting that this search did not find it');
  assert.equal(r.ok, true);
});

test('text in neither the passages nor the books is still a misquote', () => {
  // The case this distinction exists to preserve: the assistant quoting our own
  // comparison output ("no wording at all, not a single phrase in common") back
  // at the reader as though Alcott had written it.
  const r = checkQuotes('The check reports "no wording at all, not a single phrase in common".', [], SOURCE);
  assert.equal(r.misquoted.length, 1);
  assert.equal(r.ok, false);
});

test('an answer with no quotations is clean', () => {
  const r = checkQuotes('Aunt March disapproves of the engagement and threatens to disinherit Meg.', SOURCE);
  assert.equal(r.checked, 0);
  assert.equal(r.ok, true);
});

/**
 * The quotation check must not depend on how the corpus was chunked.
 *
 * Regression guard for D-86. The check took `store.chunks`, so its haystack was
 * the chunking. A quotation crossing a chunk seam is in no single chunk, and the
 * only reason it never misfired is that 60 words of overlap carry the seam:
 * across 545 straddling spans, 545 were found solely in the following chunk. The
 * README invites the reader to set overlap to zero, which would have turned real
 * prose into reported misquotations.
 */
test('a quotation that crosses a chunk seam is not called a misquote', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { store } = await import('../retrieval/store.js');
  const { config } = await import('../config.js');
  if (!fs.existsSync(path.join(config.paths.index, 'chunks.json'))) return;

  store.load();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const corpus = store.chapterCorpus();
  let tested = 0;

  for (const bookId of ['little_women', 'pride_prejudice']) {
    const chapters = [...new Set(store.chunks.filter((c) => c.bookId === bookId).map((c) => c.chapterIndex))];
    for (const ci of chapters.slice(0, 6)) {
      const cs = store.chapter(bookId, ci);
      const chap = norm(store.chapterText(bookId, ci));
      for (let i = 0; i < cs.length - 1; i++) {
        const w = norm(cs[i].text).split(' ');
        if (w.length < 30) continue;
        const tail = w.slice(-15).join(' ');
        const at = chap.indexOf(tail);
        if (at < 0) continue;
        const span = chap.slice(at, at + tail.length + 130).trim();
        if (norm(cs[i].text).includes(span)) continue; // not a straddle
        tested++;
        const r = checkQuotes(`The narrator writes: "${span}"`, [], corpus);
        assert.equal(r.misquoted.length, 0, `real prose across a chunk seam called a misquote: "${span.slice(0, 60)}"`);
      }
    }
  }
  assert.ok(tested > 0, 'found no straddling spans to test');
});
