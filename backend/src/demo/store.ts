import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * Persistence for the public demo, and nothing else.
 *
 * The local build keeps threads in the browser and appends feedback to a
 * JSONL file, which is correct for a tool one person runs on their own machine.
 * A link handed to a tester is a different situation: their conversation has to
 * survive a reload on a container that can restart under them, and the whole
 * point of asking someone to try it is to be able to read afterwards what they
 * hit. Both of those need a server-side store.
 *
 * SQLite on a mounted volume rather than a managed Postgres. The working set is
 * a few testers and a few hundred rows; a second service to run, pay for and
 * secure would be answering a scale question nobody has asked. Same reasoning as
 * D-05 declining a vector database, applied to the other end of the system.
 *
 * Inert when DEMO_DB_PATH is unset: every call becomes a no-op, so the code path
 * the local build runs is unchanged.
 */

let db: Database.Database | null = null;

export function openDb(): Database.Database | null {
  if (db) return db;
  if (!config.demo.dbPath) return null;
  fs.mkdirSync(path.dirname(config.demo.dbPath), { recursive: true });
  db = new Database(config.demo.dbPath);
  // WAL so a reader is never blocked by the write that follows an answer.
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id          TEXT PRIMARY KEY,
      visitor     TEXT NOT NULL,
      title       TEXT NOT NULL DEFAULT 'New thread',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS turns (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      role        TEXT NOT NULL,
      content     TEXT NOT NULL,
      citations   TEXT,
      steps       TEXT,
      claims      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS turns_by_thread ON turns(thread_id, id);

    CREATE TABLE IF NOT EXISTS feedback (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor     TEXT,
      verdict     TEXT NOT NULL,
      fault       TEXT,
      question    TEXT NOT NULL,
      answer      TEXT,
      cited_ids   TEXT,
      created_at  INTEGER NOT NULL
    );

    -- One row per answered question. Every number here already existed in a
    -- trace and was thrown away when the request ended.
    CREATE TABLE IF NOT EXISTS usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor       TEXT,
      thread_id     TEXT,
      question      TEXT NOT NULL,
      ms            INTEGER,
      prompt_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd      REAL,
      tools         TEXT,
      created_at    INTEGER NOT NULL
    );

    -- An answer where a guardrail fired. This is the table worth reading: it
    -- turns a failure someone actually hit into a candidate eval case without
    -- anyone having to notice it and report it. Same intent as the downvote
    -- path in D-45, but it does not depend on the reader saying anything.
    CREATE TABLE IF NOT EXISTS flagged (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      visitor      TEXT,
      question     TEXT NOT NULL,
      answer       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      detail       TEXT,
      created_at   INTEGER NOT NULL
    );
  `);
  return db;
}

const now = () => Date.now();

export const store = {
  ready: () => Boolean(config.demo.dbPath),

  listThreads(visitor: string) {
    const d = openDb();
    if (!d) return [];
    const rows = d.prepare(
      'SELECT id, title, created_at, updated_at FROM threads WHERE visitor = ? ORDER BY updated_at DESC LIMIT 40',
    ).all(visitor) as any[];
    const turns = d.prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY id');
    return rows.map((t) => ({
      id: t.id,
      title: t.title,
      at: t.updated_at,
      turns: (turns.all(t.id) as any[]).map((r) => ({
        role: r.role,
        content: r.content,
        citations: r.citations ? JSON.parse(r.citations) : undefined,
        steps: r.steps ? JSON.parse(r.steps) : undefined,
        claims: r.claims ? JSON.parse(r.claims) : undefined,
      })),
    }));
  },

  saveThread(visitor: string, thread: { id: string; title: string; turns: any[] }) {
    const d = openDb();
    if (!d) return;
    const t = now();
    // The id arrives from the request path and the visitor is a cookie, so both are
    // caller-supplied. Without this check a PUT to someone else's thread id deletes
    // their turns and writes yours into a row that stays under their name: the
    // ON CONFLICT clause deliberately never reassigns `visitor`. Unknown id = new thread.
    const owner = d.prepare('SELECT visitor FROM threads WHERE id = ?').get(thread.id) as
      | { visitor: string }
      | undefined;
    if (owner && owner.visitor !== visitor) return;

    const ins = d.prepare(`INSERT INTO turns (thread_id, role, content, citations, steps, claims, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`);
    // One transaction: the delete below drops every turn before reinserting, so a
    // failure between the two would leave the conversation empty.
    const write = d.transaction((rows: any[]) => {
      d.prepare(`INSERT INTO threads (id, visitor, title, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`)
        .run(thread.id, visitor, thread.title ?? 'New thread', t, t);
      // Rewritten rather than diffed. A conversation is at most a few dozen rows
      // and working out which turns are new is a bug waiting to happen for no gain.
      d.prepare('DELETE FROM turns WHERE thread_id = ?').run(thread.id);
      for (const r of rows) {
        ins.run(thread.id, r.role, r.content ?? '',
          r.citations ? JSON.stringify(r.citations) : null,
          r.steps ? JSON.stringify(r.steps) : null,
          r.claims ? JSON.stringify(r.claims) : null, t);
      }
    });
    write(thread.turns ?? []);
  },

  deleteThread(visitor: string, id: string) {
    const d = openDb();
    if (!d) return;
    // The turns delete is scoped through the threads table for the same reason as
    // saveThread: unscoped, any known thread id emptied a stranger's conversation
    // while the visitor-checked threads delete below correctly did nothing.
    const remove = d.transaction(() => {
      d.prepare('DELETE FROM turns WHERE thread_id IN (SELECT id FROM threads WHERE id = ? AND visitor = ?)')
        .run(id, visitor);
      d.prepare('DELETE FROM threads WHERE id = ? AND visitor = ?').run(id, visitor);
    });
    remove();
  },

  feedback(row: { visitor?: string; verdict: string; fault?: string; question: string; answer?: string; citedIds?: string[] }) {
    const d = openDb();
    if (!d) return;
    d.prepare(`INSERT INTO feedback (visitor, verdict, fault, question, answer, cited_ids, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(row.visitor ?? null, row.verdict, row.fault ?? null, row.question,
           (row.answer ?? '').slice(0, 8000), JSON.stringify(row.citedIds ?? []), now());
  },

  usage(row: { visitor?: string; threadId?: string; question: string; trace?: any; tools?: string[] }) {
    const d = openDb();
    if (!d) return;
    const u = row.trace?.usage ?? {};
    d.prepare(`INSERT INTO usage (visitor, thread_id, question, ms, prompt_tokens, output_tokens, cost_usd, tools, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.visitor ?? null, row.threadId ?? null, row.question.slice(0, 1000),
           row.trace?.totalMs ?? null, u.promptTokens ?? null, u.completionTokens ?? null,
           row.trace?.estimatedCostUsd ?? null, JSON.stringify(row.tools ?? []), now());
  },

  /**
   * Called for every answer, writing only when something actually fired. The
   * three kinds match what the interface shows a reader, so a row here and a
   * warning on screen are the same event.
   */
  flag(row: { visitor?: string; question: string; answer: string; claims?: any; audit?: any }) {
    const d = openDb();
    if (!d) return;
    const write = (kind: string, detail: unknown) =>
      d.prepare('INSERT INTO flagged (visitor, question, answer, kind, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(row.visitor ?? null, row.question.slice(0, 1000), row.answer.slice(0, 8000),
             kind, JSON.stringify(detail), now());
    if (row.claims?.misquoted?.length) write('misquoted', row.claims.misquoted);
    if (row.claims?.unsupported?.length) write('unsupported', row.claims.unsupported);
    if (row.audit && row.audit.ok === false) write('citation', row.audit.warnings ?? []);
  },

  summary() {
    const d = openDb();
    if (!d) return null;
    const one = (q: string) => (d.prepare(q).get() as any)?.n ?? 0;
    return {
      visitors: one('SELECT COUNT(DISTINCT visitor) n FROM usage'),
      questions: one('SELECT COUNT(*) n FROM usage'),
      threads: one('SELECT COUNT(*) n FROM threads'),
      up: one("SELECT COUNT(*) n FROM feedback WHERE verdict = 'up'"),
      down: one("SELECT COUNT(*) n FROM feedback WHERE verdict = 'down'"),
      flagged: one('SELECT COUNT(*) n FROM flagged'),
      costUsd: (d.prepare('SELECT COALESCE(SUM(cost_usd), 0) n FROM usage').get() as any).n,
    };
  },
};
