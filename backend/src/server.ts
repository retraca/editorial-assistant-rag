import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { BOOKS, config } from './config.js';
import { store } from './retrieval/store.js';
import { retrieve, getBm25 } from './retrieval/hybrid.js';
import { rerank } from './retrieval/rerank.js';
import { broadSearch } from './retrieval/broaden.js';
import { findSimilarPassages } from './retrieval/similar.js';
import { runChat } from './agent/chat.js';
import { Trace } from './trace.js';
import { store as demoStore } from './demo/store.js';
import { authorised, checkPassword, gateOn, grant, recordQuestion, visitorId, withinLimit } from './demo/gate.js';

const app = Fastify({ logger: false });

/**
 * Serve the compiled interface from the API process, when there is one to serve.
 *
 * Only the deployed image builds the frontend into `frontend/dist`; locally Vite
 * serves it and this directory does not exist. Registering conditionally keeps
 * one server file for both, instead of a second entrypoint that would drift.
 */
const staticRoot = path.join(config.paths.index, '..', '..', 'frontend', 'dist');
const servesUi = fs.existsSync(path.join(staticRoot, 'index.html'));
if (servesUi) {
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: staticRoot });
  // Anything that is not an API call and not a real file is the app itself.
  app.setNotFoundHandler((req, reply) => {
    if ((req.raw.url ?? '').startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

/**
 * Book ids arrive in the path and are used to index objects loaded from disk.
 * Validating against the known set turns any other value into a 404 instead of
 * a property lookup on attacker-chosen keys.
 */
const knownBook = (id: string) => BOOKS.some((b) => b.id === id);

/**
 * The gate, applied once at the front rather than remembered on each route.
 * Forgetting a decorator on one handler is how a private thing becomes public,
 * so the default is closed and the exceptions are named here in one place.
 */
const OPEN = new Set(['/api/health', '/api/unlock']);
app.addHook('onRequest', async (req, reply) => {
  if (!gateOn()) return;
  const url = (req.raw.url ?? '').split('?')[0];
  if (OPEN.has(url) || !url.startsWith('/api/')) return;
  if (!authorised(req)) return reply.code(401).send({ error: 'This demo needs a password.' });
});

app.post('/api/unlock', async (req, reply) => {
  const { password } = (req.body ?? {}) as { password?: string };
  if (!gateOn()) return { ok: true };
  if (!checkPassword(password ?? '')) return reply.code(401).send({ error: 'That password is not right.' });
  grant(reply);
  return { ok: true };
});
// Local tool. `origin: true` reflects whatever origin asks, which is fine for a
// same-machine demo and wrong the moment this is hosted, so the allowance is
// explicit rather than reflexive. See DECISIONS.md D-75.
await app.register(cors, {
  origin: (origin, cb) => cb(null, !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)),
});

// Recent traces, kept in memory so the UI can show what a request actually did.
// A ring buffer, not a database: this is a local tool. See DECISIONS.md D-10.
const recentTraces: unknown[] = [];
/**
 * What one answered question leaves behind, when a database is configured.
 *
 * Cost and latency were already measured per request and discarded when the
 * response ended; a flagged answer was already computed and only ever shown to
 * whoever asked. Persisting both is the difference between a demo somebody tried
 * and a demo you can read afterwards. Silent by design: a write failing here
 * must never cost the reader their answer.
 */
function record(who: string, messages: { role: string; content: string }[], result: any) {
  if (!demoStore.ready()) return;
  const question = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  try {
    demoStore.usage({
      visitor: who, question, trace: result.trace,
      tools: (result.steps ?? []).map((s: any) => s.tool),
    });
    demoStore.flag({ visitor: who, question, answer: result.answer ?? '', claims: result.claims, audit: result.audit });
  } catch { /* never fail a request over bookkeeping */ }
}

const remember = (t: unknown) => {
  recentTraces.unshift(t);
  if (recentTraces.length > 50) recentTraces.pop();
};

app.get('/api/health', async (req) => ({
  ok: true,
  locked: gateOn() && !authorised(req),
  chunks: store.chunks.length,
  dims: store.dims,
  indexBuiltAt: store.builtAt,
}));

app.get('/api/books', async () =>
  BOOKS.map((b) => ({
    ...b,
    chapters: store.chapters(b.id).length,
    chunks: store.chunks.filter((c) => c.bookId === b.id).length,
    words: store.stats[b.id]?.words ?? 0,
  })),
);

app.get('/api/books/:id/chapters', async (req) => {
  const { id } = req.params as { id: string };
  return store.chapters(id);
});

/**
 * Chapter summaries and key moments, generated at ingest (D-43). Loaded lazily
 * and cached, so the API works whether or not the pass has been run.
 */
const getSummaries = () => store.notes();

app.get('/api/books/:id/summary', async (req, reply) => {
  const { id } = req.params as { id: string };
  if (!knownBook(id)) return reply.code(404).send({ error: 'Unknown book' });
  const s = getSummaries()?.books?.[id];
  if (!s) return reply.code(404).send({ error: 'No summary yet. Run `npm run summarise`.' });
  // The notes were generated for every section, including the Gutenberg back
  // matter that D-73 stopped counting as chapters. Filter on the way out so the
  // interface and the counts agree.
  return {
    summary: s.summary,
    chapters: s.chapters
      .filter((c: any) => store.isChapter(id, c.title))
      .map((c: any) => ({ index: c.index, title: c.title, summary: c.summary })),
  };
});

/** Full text of one chapter. The Read view. */
app.get('/api/books/:id/chapters/:index', async (req, reply) => {
  const { id, index } = req.params as { id: string; index: string };
  if (!knownBook(id)) return reply.code(404).send({ error: 'Unknown book' });
  const chapters = store.chapters(id);
  const meta = chapters.find((c) => c.index === Number(index));
  if (!meta) return reply.code(404).send({ error: `No chapter ${index} in ${id}` });
  const note = getSummaries()?.books?.[id]?.chapters?.find((c: any) => c.index === Number(index));
  return {
    ...meta,
    bookId: id,
    summary: note?.summary ?? null,
    moments: note?.moments ?? [],
    text: store.chapterText(id, Number(index)),
    prev: chapters.find((c) => c.index < meta.index && c.index === meta.index - 1)?.index ?? null,
    next: chapters.find((c) => c.index === meta.index + 1)?.index ?? null,
  };
});

app.post('/api/chat', async (req, reply) => {
  const body = req.body as { messages?: { role: 'user' | 'assistant'; content: string }[]; books?: string[] };
  if (!body?.messages?.length) return reply.code(400).send({ error: 'messages required' });
  const who = visitorId(req, reply);
  const quota = withinLimit(who);
  if (!quota.ok) {
    return reply.code(429).send({
      error: `This demo allows ${quota.limit} questions an hour and you have used them. Try again shortly.`,
    });
  }
  try {
    recordQuestion(who);
    const result = await runChat(body.messages, undefined, body.books);
    remember(result.trace);
    record(who, body.messages, result);
    return result;
  } catch (err) {
    // Without this, an exhausted retry surfaces as a bare Fastify 500 and the UI
    // shows "Request failed (500)". /api/compare already returned a clean error;
    // this makes the two consistent.
    const message = (err as Error).message ?? 'Unknown error';
    req.log?.error?.(message);
    // The upstream error is logged, never returned. It carried the provider's
    // name, raw response body and policy URLs straight to the browser.
    const rateLimited = /\b429\b|rate limit/i.test(message);
    const filtered = /content management policy|content_filter/i.test(message);
    return reply.code(rateLimited ? 429 : 502).send({
      error: rateLimited
        ? 'The model provider is rate limiting this sandbox. Wait a moment and try again.'
        : filtered
          ? 'That request was refused by the model provider\u2019s safety filter. Try rephrasing it.'
          : 'The model call failed. The details are in the server log.',
    });
  }
});

/**
 * Same as /api/chat, streamed as newline-delimited JSON.
 *
 * A turn takes 10-20s and the model is silent for most of it while tools run.
 * Without progress the reader stares at a spinner and cannot tell working from
 * hung. Each event says what is happening in plain words; the final event
 * carries the same payload /api/chat returns.
 */
app.post('/api/chat/stream', async (req, reply) => {
  const body = req.body as { messages?: { role: 'user' | 'assistant'; content: string }[]; books?: string[] };
  if (!body?.messages?.length) return reply.code(400).send({ error: 'messages required' });
  const who = visitorId(req, reply);
  const quota = withinLimit(who);
  if (!quota.ok) {
    return reply.code(429).send({
      error: `This demo allows ${quota.limit} questions an hour and you have used them. Try again shortly.`,
    });
  }

  reply.raw.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const send = (o: unknown) => reply.raw.write(`${JSON.stringify(o)}\n`);

  try {
    recordQuestion(who);
    const result = await runChat(body.messages, (p) => send({ type: 'progress', ...p }), body.books);
    remember(result.trace);
    record(who, body.messages, result);
    send({ type: 'done', result });
  } catch (err) {
    const message = (err as Error).message ?? 'Unknown error';
    send({
      type: 'error',
      error: /\b429\b|rate limit/i.test(message)
        ? 'The model provider is rate limiting this sandbox. Wait a moment and try again.'
        : `Upstream model call failed: ${message.slice(0, 300)}`,
    });
  }
  reply.raw.end();
});

app.post('/api/search/broaden', async (req, reply) => {
  const { query, book, k } = req.body as { query?: string; book?: string; k?: number };
  if (!query) return reply.code(400).send({ error: 'query required' });
  const trace = new Trace();
  const { phrases, hits } = await broadSearch({
    query, bookId: book, k: Math.min(k ?? 5, 20), trace,
  });
  trace.log();
  remember(trace.summary());
  return {
    phrases,
    hits: hits.map((h) => ({ ...h.chunk, via: h.via })),
    trace: trace.summary(),
  };
});

app.post('/api/search', async (req, reply) => {
  const { query, book, k, rerank: useRerank } = req.body as {
    query?: string; book?: string; k?: number; rerank?: boolean;
  };
  if (!query) return reply.code(400).send({ error: 'query required' });
  const trace = new Trace();
  const want = Math.min(k ?? 8, 20);
  // Reranking needs candidates to reorder, so over-fetch then cut back.
  let hits = await retrieve({ query, bookId: book, k: useRerank ? Math.max(want * 3, 24) : want, trace });
  if (useRerank) hits = (await rerank(query, hits, want, trace)) as typeof hits;
  trace.log();
  remember(trace.summary());
  return {
    hits: hits.map((h) => ({
      ...h.chunk,
      score: h.score,
      denseRank: h.denseRank,
      sparseRank: h.sparseRank,
    })),
    trace: trace.summary(),
  };
});

app.post('/api/compare', async (req, reply) => {
  const { book_a, book_b, theme, top_n } = req.body as {
    book_a?: string;
    book_b?: string;
    theme?: string;
    top_n?: number;
  };
  if (!book_a || !book_b) return reply.code(400).send({ error: 'book_a and book_b required' });
  const trace = new Trace();
  try {
    const result = await findSimilarPassages({
      bookA: book_a,
      bookB: book_b,
      theme,
      topN: Math.min(top_n ?? 5, 10),
      trace,
    });
    trace.log();
    remember(trace.summary());
    return { ...result, trace: trace.summary() };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

/**
 * Reader feedback, and the reason it is worth collecting.
 *
 * A thumbs-down alone says something was wrong, not what. The follow-up asks
 * which half failed. The passages or the writing, because that maps onto the
 * two things the eval already measures separately (D-14). Every negative rating
 * is appended as a case, so a complaint from real use becomes a regression test
 * rather than a feeling. See DECISIONS.md D-45.
 */
app.post('/api/feedback', async (req, reply) => {
  const { verdict, fault, question, answer, citedIds, traceId } = req.body as {
    verdict?: 'up' | 'down'; fault?: 'retrieval' | 'writing' | 'other';
    question?: string; answer?: string; citedIds?: string[]; traceId?: string;
  };
  if (!verdict || !question) return reply.code(400).send({ error: 'verdict and question required' });

  const dir = path.join(config.paths.index, '..', 'feedback');
  fs.mkdirSync(dir, { recursive: true });
  const row = {
    at: new Date().toISOString(), verdict, fault: fault ?? null, question,
    answer: (answer ?? '').slice(0, 4000), citedIds: citedIds ?? [], traceId: traceId ?? null,
  };
  fs.appendFileSync(path.join(dir, 'feedback.jsonl'), `${JSON.stringify(row)}\n`);
  // The file stays the record for a local run. The table is what makes a rating
  // from someone else's browser readable from here.
  try {
    demoStore.feedback({
      visitor: visitorId(req, reply), verdict, fault, question,
      answer: answer ?? '', citedIds: citedIds ?? [],
    });
  } catch { /* the JSONL write already succeeded */ }

  // A downvote is a failing case. Written in the eval's own shape so it can be
  // merged into the suite without translation.
  if (verdict === 'down') {
    const cse = {
      id: `fb-${Date.now()}`,
      type: fault === 'retrieval' ? 'retrieval' : 'answer',
      query: question,
      reportedFault: fault ?? 'other',
      note: 'Added from reader feedback. Fill in the expectation before merging into cases.json.',
      ...(fault === 'retrieval' ? { book: null, anyOf: [] } : { mustMention: [] }),
    };
    fs.appendFileSync(path.join(dir, 'candidate-cases.jsonl'), `${JSON.stringify(cse)}\n`);
  }
  return { ok: true };
});

app.get('/api/feedback/summary', async () => {
  const f = path.join(config.paths.index, '..', 'feedback', 'feedback.jsonl');
  if (!fs.existsSync(f)) return { up: 0, down: 0, faults: {} };
  const rows = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const faults: Record<string, number> = {};
  for (const r of rows) if (r.verdict === 'down' && r.fault) faults[r.fault] = (faults[r.fault] ?? 0) + 1;
  return { up: rows.filter((r) => r.verdict === 'up').length, down: rows.filter((r) => r.verdict === 'down').length, faults };
});

app.get('/api/traces', async () => recentTraces);

/**
 * Server-side threads, available only when a database is configured.
 *
 * The browser copy stays authoritative for the local build. Here the server is,
 * which removes the two-tab problem at the root rather than reconciling it: one
 * writer, one row per thread, no merge to get wrong.
 */
app.get('/api/threads', async (req, reply) => {
  if (!demoStore.ready()) return reply.code(404).send({ error: 'No server-side threads in this build.' });
  return demoStore.listThreads(visitorId(req, reply));
});

app.put('/api/threads/:id', async (req, reply) => {
  if (!demoStore.ready()) return reply.code(404).send({ error: 'No server-side threads in this build.' });
  const { id } = req.params as { id: string };
  const body = req.body as { title?: string; turns?: unknown[] };
  demoStore.saveThread(visitorId(req, reply), { id, title: body?.title ?? 'New thread', turns: (body?.turns ?? []) as any[] });
  return { ok: true };
});

app.delete('/api/threads/:id', async (req, reply) => {
  if (!demoStore.ready()) return reply.code(404).send({ error: 'No server-side threads in this build.' });
  const { id } = req.params as { id: string };
  demoStore.deleteThread(visitorId(req, reply), id);
  return { ok: true };
});

/** What the demo produced, for whoever is running it. */
app.get('/api/demo/summary', async (req, reply) => {
  if (!demoStore.ready()) return reply.code(404).send({ error: 'No database in this build.' });
  void visitorId(req, reply);
  return demoStore.summary();
});

const start = async () => {
  store.load();
  getBm25(); // build the lexical index at boot, not on the first query
  console.log(
    `Loaded ${store.chunks.length} chunks (${store.dims}d), index built ${store.builtAt}`,
  );
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Listening on http://localhost:${config.port}`);
};

start().catch((err) => {
  // A missing index is the expected state on a first run, not a crash. Printing
  // a stack trace for it makes the very first thing a reader sees look like a
  // broken project when it is an instruction. Anything unexpected still gets
  // the full trace, because that is a real fault and the stack is the evidence.
  const expected = err instanceof Error && /Run `npm run/.test(err.message);
  console.error(expected ? `\n${err.message}\n` : err);
  process.exit(1);
});
