import test from 'node:test';
import assert from 'node:assert/strict';

import { splitSentences, chunkSections, type Chunk } from '../ingest/chunk.js';
import { BM25, tokenize } from '../retrieval/bm25.js';
import { aliasExpansions } from '../retrieval/aliases.js';
import { shingles } from '../retrieval/reuse.js';
import { auditCitations } from '../agent/verify.js';
import { rrf } from '../retrieval/hybrid.js';

/**
 * Unit tests for the deterministic half of the system.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT FOR. The eval harness measures whether
 * retrieval and generation are any GOOD. It is a quality instrument, it costs
 * money, it needs an API key, and its numbers move for reasons that are not
 * regressions. These tests measure whether the deterministic pieces still do
 * what they are documented to do. They are free, offline, and a failure here is
 * always a bug.
 *
 * Every case below is a bug that was actually hit, or an invariant a decision in
 * DECISIONS.md depends on. Nothing here tests that a function returns the type
 * it declares. TypeScript already did that. See DECISIONS.md D-54.
 *
 * Run: npm test
 */

/* ─────────────────────── sentence splitting (D-04) ─────────────────────── */

test('splitSentences does not break on abbreviations', () => {
  // The bug: "Mr. Bingley" split into two sentences, so the overlap carry and
  // every downstream chunk boundary landed mid-name.
  const s = splitSentences('Mr. Bingley called on Mrs. Bennet. She was delighted.');
  assert.equal(s.length, 2);
  assert.match(s[0], /Mr\. Bingley called on Mrs\. Bennet\./);
});

test('an honorific after an opening quote does not split', () => {
  // Found by the claim audit, which received "and concludes that \"Mr." as a
  // whole claim. The guard required whitespace before the honorific, so a
  // quotation mark defeated it, and both books open dialogue with a title
  // constantly. This corrupted chunk boundaries in the corpus itself.
  const s = splitSentences('He concludes that "Mr. Wickham\'s object was her fortune." He also wrote.');
  assert.equal(s.length, 2);
  assert.match(s[0], /Mr\. Wickham/);

  const curly = splitSentences('\u201CMr. Bennet, how can you abuse them?\u201D She was delighted.');
  assert.equal(curly.length, 2, 'curly quotes must be handled too, which is what the books use');
});

test('splitSentences keeps quoted dialogue with its sentence', () => {
  const s = splitSentences('"It is a truth," said she. "A single man must want a wife."');
  assert.equal(s.length, 2);
});

test('splitSentences returns the whole text when there is no terminator', () => {
  const s = splitSentences('a fragment with no full stop');
  assert.deepEqual(s, ['a fragment with no full stop']);
});

/* ─────────────────────── chunking (D-03, D-05) ─────────────────────── */

const section = (index: number, title: string, paragraphs: string[]) =>
  ({ index, title, paragraphs, wordCount: paragraphs.join(' ').split(/\s+/).length });

test('chunkSections splits an over-long paragraph rather than emitting it whole', () => {
  // Darcy's letter is one <p> of 2,594 words in the Gutenberg source. Before
  // the sentence-level split it became a single chunk twelve times the target,
  // which no retrieval k can compensate for.
  const monster = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} of the letter.`).join(' ');
  const chunks = chunkSections([section(0, 'CHAPTER XXXV.', [monster])],
    { id: 'pp', title: 'Pride and Prejudice', author: 'Austen' });

  assert.ok(chunks.length > 1, 'a 2,000-word paragraph must produce more than one chunk');
  const words = (c: Chunk) => c.text.split(/\s+/).length;
  assert.ok(Math.max(...chunks.map(words)) < 900,
    `no chunk should run away: largest was ${Math.max(...chunks.map(words))} words`);
});

test('chunk ids are stable, unique, and encode book:section:index', () => {
  const chunks = chunkSections(
    [section(3, 'CHAPTER IV.', Array.from({ length: 30 }, (_, i) => `Paragraph ${i}. `.repeat(30)))],
    { id: 'pp', title: 'Pride and Prejudice', author: 'Austen' },
  );
  assert.ok(chunks.length > 1);
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length, 'ids must be unique');
  for (const c of chunks) assert.match(c.id, /^pp:3:\d+$/);
});

test('every chunk carries the metadata a citation needs', () => {
  const [c] = chunkSections([section(0, 'CHAPTER I.', ['Short chapter.'])],
    { id: 'pp', title: 'Pride and Prejudice', author: 'Austen' });
  // A citation renders "PP I" and opens the passage, all four fields are load-bearing.
  assert.equal(c.bookId, 'pp');
  assert.equal(c.bookTitle, 'Pride and Prejudice');
  assert.equal(c.chapterTitle, 'CHAPTER I.');
  assert.equal(c.chapterIndex, 0);
});

/* ─────────────────────── BM25 (D-06) ─────────────────────── */

const fixture: Chunk[] = [
  { id: 'a:0:0', bookId: 'a', bookTitle: 'A', author: 'X', chapterTitle: 'One', chapterIndex: 0,
    text: 'Mrs Younge was the governess who assisted in the elopement.', chunkIndex: 0, wordCount: 10 },
  { id: 'a:0:1', bookId: 'a', bookTitle: 'A', author: 'X', chapterTitle: 'One', chapterIndex: 0,
    text: 'The weather was fine and the party walked to Meryton together.', chunkIndex: 1, wordCount: 11 },
  { id: 'b:0:0', bookId: 'b', bookTitle: 'B', author: 'Y', chapterTitle: 'One', chapterIndex: 0,
    text: 'Marriage is a subject on which the sisters rarely agreed.', chunkIndex: 0, wordCount: 10 },
];

test('BM25 ranks a rare exact name first. The case dense retrieval loses', () => {
  // D-24: "Mrs Younge" misses entirely at k=8 under dense retrieval. Sparse
  // carrying this is the whole reason hybrid is kept.
  const hits = new BM25(fixture).search('Mrs Younge', 3);
  assert.equal(hits[0].chunk.id, 'a:0:0');
});

test('BM25 respects the book filter', () => {
  const hits = new BM25(fixture).search('marriage sisters', 5, (c) => c.bookId === 'a');
  assert.ok(hits.every((h) => h.chunk.bookId === 'a'), 'scoped search must not leak the other book');
});

test('BM25 returns nothing for a term absent from the corpus', () => {
  assert.equal(new BM25(fixture).search('helicopter', 5).length, 0);
});

test('tokenize lowercases and drops punctuation', () => {
  assert.deepEqual(tokenize('Mrs. Bennet, delighted!'), ['mrs', 'bennet', 'delighted']);
});

/* ─────────────────────── aliases (D-25) ─────────────────────── */

test('aliases expand bidirectionally', () => {
  assert.ok(aliasExpansions(['lizzy']).includes('elizabeth'));
  assert.ok(aliasExpansions(['laurie']).includes('theodore'));
});

test('beth does NOT expand to elizabeth', () => {
  // Deliberate omission. "elizabeth" is in 413 Pride and Prejudice chunks and 2
  // Little Women ones, so the link would drag Austen into every Alcott query.
  // If someone "fixes" the missing alias, this test explains why it is missing.
  assert.ok(!aliasExpansions(['beth']).includes('elizabeth'));
});

test('a word in no alias group expands to nothing', () => {
  assert.deepEqual(aliasExpansions(['weather']), []);
});

/* ─────────────────────── RRF (D-07) ─────────────────────── */

const scored = (ids: string[]) =>
  ids.map((id, i) => ({ chunk: { ...fixture[0], id }, score: 1 - i * 0.1 }));

// rrf and auditCitations look passages up; injecting the lookup keeps these
// tests offline and independent of a built index.
const pool = new Map(['x', 'y', 'z'].map((id) => [id, { ...fixture[0], id }]));
const lookup = (id: string) => pool.get(id);
const exists = (id: string) => retrieved.some((c) => c.id === id) || ['a:0:0', 'b:0:0'].includes(id);

test('RRF ranks a passage found by both arms above one found by either alone', () => {
  const fused = rrf(scored(['x', 'y']), scored(['y', 'z']), 3, 10, lookup);
  assert.equal(fused[0].chunk.id, 'y', 'agreement between arms should win');
});

test('RRF reports which arm found each passage, and null for the arm that did not', () => {
  // The UI shows these as "meaning #1 / no wording match". A null that silently
  // became 0 would tell the reader the opposite of the truth.
  const fused = rrf(scored(['x']), scored(['z']), 5, 10, lookup);
  const x = fused.find((h) => h.chunk.id === 'x')!;
  assert.equal(x.denseRank, 0);
  assert.equal(x.sparseRank, null);
});

test('RRF with one empty arm degrades to the other arm, in order', () => {
  const fused = rrf(scored(['x', 'y', 'z']), [], 3, 10, lookup);
  assert.deepEqual(fused.map((h) => h.chunk.id), ['x', 'y', 'z']);
});

/* ─────────────────────── verbatim reuse (D-20) ─────────────────────── */

test('shingles are 8 words long and overlap by one word', () => {
  const text = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
  const s = shingles(text);
  assert.equal(s.size, 5, '12 words yields 12-8+1 = 5 shingles');
  assert.ok([...s.values()].every((v) => v.split(' ').length === 8));
});

test('a text shorter than the shingle width produces none', () => {
  assert.equal(shingles('too short for eight').size, 0);
});

test('identical text shingles identically; one changed word breaks the match', () => {
  const a = shingles('the quick brown fox jumped over the lazy dog today');
  const b = shingles('the quick brown fox jumped over the lazy dog today');
  const c = shingles('the quick brown fox vaulted over the lazy dog today');
  assert.deepEqual([...a.keys()], [...b.keys()]);
  assert.notDeepEqual([...a.keys()], [...c.keys()]);
});

/* ─────────────────────── citation audit (D-18, D-30) ─────────────────────── */

const retrieved: Chunk[] = [fixture[0], fixture[2]];

test('an answer citing only retrieved passages passes', () => {
  const audit = auditCitations('She helped them [a:0:0].', retrieved, new Set(), exists);
  assert.equal(audit.ok, true);
});

test('a fabricated passage id is caught', () => {
  const audit = auditCitations('As stated [zz:99:9].', retrieved, new Set(), exists);
  assert.equal(audit.ok, false);
  assert.ok(audit.warnings.join(' ').length > 0);
});

test('a citation from an earlier turn is NOT flagged', () => {
  // The regression that made the guardrail cry wolf: asking "in bullet points"
  // after a real answer reformats evidence already gathered, and every one of
  // its nine citations was reported as unretrieved.
  const audit = auditCitations('Restated [b:0:0].', [], new Set(['b:0:0']), exists);
  assert.equal(audit.ok, true);
});

test('a fabricated id is still caught when prior citations exist', () => {
  const audit = auditCitations('Restated [b:0:0] and [zz:99:9].', [], new Set(['b:0:0']), exists);
  assert.equal(audit.ok, false);
});

test('a long uncited answer is reported, a short one is not', () => {
  // The threshold is deliberate: a refusal legitimately cites nothing, and
  // flagging it would train the reader to ignore the warning.
  const long = 'Marriage matters a great deal in both books. '.repeat(8);
  assert.ok(auditCitations(long, retrieved, new Set(), exists).warnings.length > 0);
  assert.equal(auditCitations('I cannot answer that.', retrieved, new Set(), exists).ok, true);
});

/**
 * Regression guard for D-89.
 *
 * The closer class after terminal punctuation allowed exactly one character and
 * omitted the curly right single quote. A sentence ending inside nested
 * quotation, which is most of the dialogue in these two books, therefore never
 * split, and the following sentence was glued onto the end of the quotation.
 * It surfaced in the claim audit, where a flagged statement was shown to the
 * reader beginning mid-quote.
 */
test('a sentence ending in nested quotation marks still splits', () => {
  const s = splitSentences('She said “‘I am so proud!’” Amy also defends Jo. Then it ended.');
  assert.equal(s.length, 3, `expected 3 sentences, got ${s.length}: ${JSON.stringify(s)}`);
  assert.ok(s[1].startsWith('Amy also defends'), `second sentence leaked the quote: ${s[1]}`);
});

test('multiple closing marks do not break the abbreviation guard', () => {
  const s = splitSentences('He met Mr. Bennet. She quoted “‘Yes!’” and left.');
  assert.ok(s[0].includes('Mr. Bennet'), `split on the honorific: ${JSON.stringify(s)}`);
});

/**
 * Regression guard for D-90.
 *
 * The claim audit has jurisdiction over statements about the books. A sentence
 * addressed to the reader is not one, and reporting "no passage supports or
 * contradicts this" about an offer of help is true and useless. It reached a
 * reader as: "If you mean a different John or a particular scene, give me a
 * little more context" reported as judgement rather than evidence.
 */
test('a sentence addressed to the reader is not audited as a claim', async () => {
  const { claimsOf } = await import('../agent/claims.js');
  // The citation sits inside the sentence it supports, which is how the model
  // actually writes them; after the full stop it belongs to the next sentence.
  const answer =
    'Jo tells Laurie that John is going home with her [little_women:4:2]. ' +
    'If you mean a different John or a particular scene, give me a little more context. ' +
    'Let me know which chapter you had in mind.';
  // claimsOf drops a sentence whose citation does not resolve, so the map has to
  // contain the chunk the answer cites.
  const byId = new Map([['little_women:4:2', { id: 'little_women:4:2' } as any]]);
  const claims = claimsOf(answer, byId);
  const texts = claims.map((c) => c.text.toLowerCase());
  assert.ok(!texts.some((t) => t.startsWith('if you mean')), `audited an offer: ${JSON.stringify(texts)}`);
  assert.ok(!texts.some((t) => t.includes('let me know')), `audited an offer: ${JSON.stringify(texts)}`);
  assert.ok(texts.some((t) => t.includes('john is going home')), 'dropped a real claim');
});
