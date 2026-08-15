import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { toolDefs } from '../agent/tools.js';
import cases from '../eval/cases.json' with { type: 'json' };

/**
 * Tests that the documentation describes the system that exists.
 *
 * WHY THIS FILE EXISTS. Over three days of building, the README came to name
 * three surfaces that had been replaced by two, claim six tools when five were
 * registered, quote a table over 20 cases when there were 24, and state that
 * reranking was OFF when it had shipped ON since D-20. Every one of those was
 * true when written. None of them survived the next change, and nothing failed.
 *
 * Documentation drift cannot be fixed by intending to update the docs. It is
 * fixed by making the drift break a test, so that the change which invalidates
 * a sentence is the change that has to rewrite it. See DECISIONS.md D-59.
 *
 * The prose rules are here for the same reason: a style rule that lives only in
 * someone's head is a rule that is already being broken somewhere.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

const README = read('README.md');
const DECISIONS = read('DECISIONS.md');
const APP = read('frontend/src/App.tsx');
const ENV = read('.env.example');
const PKG = JSON.parse(read('backend/package.json'));

/** Every shipped file whose prose a reader can see, including comments. */
const sourceFiles = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        walk(rel);
      } else if (/\.(ts|tsx|css|md)$/.test(e.name)) {
        out.push(rel);
      }
    }
  };
  walk('backend/src');
  walk('frontend/src');
  return [...out, 'README.md', 'DECISIONS.md'];
};

/* ─────────────────────── the prose rules ─────────────────────── */

test('no em dashes anywhere, including code comments', () => {
  // A hard rule, and the single most reliable machine-written tell. Replace with
  // a period for a full break, a comma for an aside, a colon for elaboration.
  // Written as an escape so this file does not fail its own check.
  const EM = /\u2014/g;
  const guilty = sourceFiles()
    .map((f) => ({ f, n: (read(f).match(EM) ?? []).length }))
    .filter((x) => x.n > 0);
  assert.deepEqual(guilty, [], `em dashes found: ${guilty.map((g) => `${g.f} (${g.n})`).join(', ')}`);
});

test('no en dashes outside numeric ranges', () => {
  const bad: string[] = [];
  for (const f of sourceFiles()) {
    for (const m of read(f).matchAll(/.{12}\u2013.{12}/g)) {
          // Numeric ranges are fine. Prose is not.
      if (!/\d\s?\u2013\s?\d/.test(m[0])) bad.push(`${f}: ${m[0].trim()}`);
    }
  }
  assert.deepEqual(bad, [], `en dashes in prose: ${bad.slice(0, 5).join(' | ')}`);
});

test('user-visible copy avoids the "not X, just Y" antithesis', () => {
  // The most reliable structural tell after the em dash. State the positive
  // thing and stop; do not define it against a strawman.
  const visible = [APP, read('data/summaries.json')].join('\n');
  const hits = [...visible.matchAll(/\bis not [a-z ]{3,30}, (it is|but|just|simply|rather)\b/gi)]
    .map((m) => m[0]);
  assert.deepEqual(hits, [], `antithesis in user-visible copy: ${hits.join(' | ')}`);
});

test('generated notes are clean prose, and quotations are left alone', () => {
  // A real distinction, not a loophole. The style rules govern what this system
  // writes. They do not govern Alcott and Austen, who used em dashes freely, and
  // "fixing" a quotation would falsify the very evidence the summarise pass
  // verifies character by character against the source.
  const notes = JSON.parse(read('data/summaries.json'));
  const EM = /\u2014/;
  let written = 0;
  let quoted = 0;
  for (const book of Object.values(notes.books) as any[]) {
    if (EM.test(book.summary)) written++;
    for (const ch of book.chapters) {
      if (EM.test(ch.summary)) written++;
      for (const m of ch.moments) if (EM.test(m)) quoted++;
    }
  }
  assert.equal(written, 0, `${written} generated notes contain an em dash`);
  assert.ok(quoted > 0,
    'quotations from these novels should still contain their own em dashes; ' +
    'zero suggests someone has been editing the source text');
});

test('generated notes avoid back-cover verbs', () => {
  const BLURB = ['coming-of-age', 'grapples with', 'navigates', 'poignant', 'timeless',
                 'richly drawn', 'against the backdrop', 'at its heart', 'delves into'];
  const notes = JSON.parse(read('data/summaries.json'));
  const prose = (Object.values(notes.books) as any[])
    .flatMap((b) => [b.summary, ...b.chapters.map((c: any) => c.summary)])
    .join(' ')
    .toLowerCase();
  const found = BLURB.filter((w) => prose.includes(w));
  assert.deepEqual(found, [], `blurb language in the notes: ${found.join(', ')}`);
});

test('user-visible copy contains no banned filler', () => {
  const BANNED = [
    'passionate about', 'I thrive', 'let the work speak', 'seamlessly',
    'leverage the power', 'in today’s world', 'delve into', 'a testament to',
    'unlock the', 'game-changer', 'best-in-class',
  ];
  const visible = (APP + read('data/summaries.json')).toLowerCase();
  const found = BANNED.filter((b) => visible.includes(b.toLowerCase()));
  assert.deepEqual(found, [], `filler in user-visible copy: ${found.join(', ')}`);
});

/* ─────────────────────── docs match the code ─────────────────────── */

test('README names exactly the tools that are registered', () => {
  const registered = toolDefs.map((t) => t.function.name).sort();
  for (const name of registered) {
    assert.ok(README.includes(name), `${name} is registered but absent from the README`);
  }
  // And the count it claims in prose is the count that exists.
  const claimed = README.match(/loop with (\w+) tools/)?.[1];
  const words: Record<string, number> = {
    four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  };
  assert.equal(words[claimed ?? ''] ?? Number(claimed), registered.length,
    `README claims "${claimed}" tools; ${registered.length} are registered`);
});

test('README names the surfaces the app actually renders', () => {
  // The app is one screen with three columns now, not a set of navigable
  // surfaces, so the check is on the columns the shell renders.
  const columns = [...APP.matchAll(/className="(col-threads|col-chat|col-books)"/g)].map((m) => m[1]);
  assert.equal(new Set(columns).size, 3, 'the shell should render three columns');
  for (const word of ['threads', 'conversation', 'books']) {
    assert.ok(README.toLowerCase().includes(word),
      `the interface has a ${word} column the README does not mention`);
  }
  // And the reverse: no README section for a surface that was removed.
  for (const gone of ['Compare books \u2014', 'Retrieval \u2014']) {
    assert.ok(!README.includes(gone), `README still documents the removed "${gone}" surface`);
  }
});

test('README and the eval guide state the real number of unit tests', () => {
  // Added after the count went 24 -> 65 with the README still saying 24. The
  // earlier checks covered tools, surfaces and case counts and missed this,
  // which is the drift test drifting.
  const files = fs.readdirSync(path.join(root, 'backend/src/test'));
  const actual = files
    .filter((f) => f.endsWith('.test.ts'))
    .reduce((n, f) => n + (read(`backend/src/test/${f}`).match(/^test\(/gm) ?? []).length, 0);
  for (const doc of ['README.md', 'docs/EVALUATION.md']) {
    const claimed = read(doc).match(/(\d+) unit tests|# (\d+) tests/);
    const n = Number(claimed?.[1] ?? claimed?.[2]);
    assert.equal(n, actual, `${doc} claims ${n} tests; there are ${actual}`);
  }
});

test('every source module appears in the README layout', () => {
  // Four modules were added and none of them reached the file tree.
  const listed = read('README.md');
  const missing: string[] = [];
  for (const dir of ['agent', 'retrieval', 'ingest', 'eval']) {
    for (const f of fs.readdirSync(path.join(root, 'backend/src', dir))) {
      if (f.endsWith('.ts') && !listed.includes(f)) missing.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(missing, [], `modules absent from the README layout: ${missing.join(', ')}`);
});

test('README states the real number of eval cases', () => {
  const n = (cases as any).cases.length;
  assert.ok(README.includes(`${n} cases`),
    `there are ${n} eval cases and the README does not say so`);
});

/**
 * The total was checked and the breakdown was not, so the table that maps the
 * four use cases onto case counts sat at 43 while the total said 52.
 * A reviewer reads the table, not the sum. Both are now checked.
 */
test('the use-case table matches the cases actually written', () => {
  const counts = new Map<string, number>();
  for (const c of (cases as any).cases) {
    const g = String(c.goal ?? '?');
    counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  // Every row anywhere in the file, not the first table found: the counts were
  // written out twice and only one copy had been kept up to date.
  const rows = [...README.matchAll(/^\| (G[1-4]|guard) \| [^|]+\| (\d+) \|$/gm)];
  const wrong: string[] = [];
  for (const [, group, stated] of rows) {
    const real = counts.get(group) ?? 0;
    if (Number(stated) !== real) wrong.push(`${group}: README says ${stated}, there are ${real}`);
  }
  assert.deepEqual(wrong, [], wrong.join('; '));
  const seen = new Set(rows.map((r) => r[1]));
  const unlisted = [...counts.keys()].filter((g) => !seen.has(g));
  assert.deepEqual(unlisted, [], `groups with cases but no README row: ${unlisted.join(', ')}`);
});

/** Both files advertised 88 decisions while 101 were written. */
test('the stated number of decision entries is the real one', () => {
  const n = [...DECISIONS.matchAll(/^## D-\d+:/gm)].length;
  for (const [name, text] of [['README.md', README], ['DECISIONS.md', DECISIONS]] as const) {
    assert.ok(text.includes(`${n} entries`), `${n} decision entries, and ${name} does not say so`);
  }
});

test('every npm script the README tells you to run exists', () => {
  const invoked = [...README.matchAll(/npm (?:run )?([a-z:]+)/g)].map((m) => m[1]);
  const known = new Set([...Object.keys(PKG.scripts), 'install', 'ci']);
  const missing = [...new Set(invoked)].filter((s) => !known.has(s));
  assert.deepEqual(missing, [], `README documents scripts that do not exist: ${missing.join(', ')}`);
});

test('every env var the code requires is in .env.example', () => {
  const config = read('backend/src/config.ts');
  const required = [...config.matchAll(/req\('([A-Z_]+)'\)/g)].map((m) => m[1]);
  const missing = required.filter((v) => !ENV.includes(v));
  assert.deepEqual(missing, [], `config requires vars absent from .env.example: ${missing.join(', ')}`);
});

/**
 * The test above only covered `req(...)`, the vars without which the app cannot
 * start. Every tunable knob reached through `num(...)` or a `process.env` read
 * has a default, so omitting one breaks nothing and is invisible: .env.example
 * documented 22 of them and silently missed six. The file is the only place a
 * reviewer learns which dials exist, so an undocumented dial is a dial nobody
 * turns.
 *
 * PROJECT_ROOT and EVAL_K are deliberately absent: the first is an escape hatch
 * for running outside the repo layout, the second is an eval-only override
 * passed on the command line.
 */
test('every tunable knob is documented in .env.example', () => {
  const internal = new Set(['PROJECT_ROOT', 'EVAL_K']);
  const sources = ['backend/src/config.ts', 'backend/src/retrieval/similar.ts'].map(read).join('\n');
  const names = new Set<string>();
  for (const m of sources.matchAll(/(?:num|bool|req)\('([A-Z_0-9]+)'/g)) names.add(m[1]);
  for (const m of sources.matchAll(/process\.env\.([A-Z_0-9]+)/g)) names.add(m[1]);
  const missing = [...names].filter((v) => !internal.has(v) && !ENV.includes(v)).sort();
  assert.deepEqual(missing, [], `tunable knobs absent from .env.example: ${missing.join(', ')}`);
});

/* ─────────────────────── the decision log ─────────────────────── */

test('every D-NN referenced anywhere exists in DECISIONS.md', () => {
  const defined = new Set([...DECISIONS.matchAll(/^## (D-\d+):/gm)].map((m) => m[1]));
  const referenced = new Set<string>();
  for (const f of sourceFiles()) {
    for (const m of read(f).matchAll(/\bD-(\d\d)\b/g)) referenced.add(`D-${m[1]}`);
  }
  const dangling = [...referenced].filter((d) => !defined.has(d)).sort();
  assert.deepEqual(dangling, [], `referenced but never written: ${dangling.join(', ')}`);
});

test('every link in the decision index resolves to a heading', () => {
  const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/ /g, '-');
  const anchors = new Set(
    [...DECISIONS.matchAll(/^## (D-\d+): (.+)$/gm)].map((m) => slug(`${m[1]} ${m[2]}`)),
  );
  const broken = [...DECISIONS.matchAll(/\(#(d-[^)]+)\)/g)]
    .map((m) => m[1])
    .filter((a) => !anchors.has(a));
  assert.deepEqual(broken, [], `dead index links: ${broken.join(', ')}`);
});

test('decision numbers are unique and unbroken', () => {
  const nums = [...DECISIONS.matchAll(/^## D-(\d+):/gm)].map((m) => Number(m[1]));
  assert.equal(new Set(nums).size, nums.length, 'a decision number is used twice');
  for (let i = 0; i < nums.length; i++) {
    assert.equal(nums[i], i + 1, `decision numbering jumps at D-${String(nums[i]).padStart(2, '0')}`);
  }
});
