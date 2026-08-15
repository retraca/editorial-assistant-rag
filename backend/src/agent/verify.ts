import type { Chunk } from '../ingest/chunk.js';
import { store } from '../retrieval/store.js';

/**
 * Output guardrail: citation integrity.
 *
 * Everything else keeping this system grounded is prompt text, instructions the
 * model is asked to follow, with nothing enforcing compliance. This runs after
 * generation, in code, and cannot be talked out of its verdict.
 *
 * It checks three things, in increasing order of what they imply:
 *
 *   unresolved. The answer cites an id that does not exist in the index.
 *                  The model invented a citation. Unambiguous fabrication.
 *   notRetrieved. The id exists but was never returned by any tool call this
 *                  turn. The model is citing from memory of the corpus rather
 *                  than from evidence in front of it.
 *   uncited. The answer makes claims but cites nothing at all, despite
 *                  having retrieved passages.
 *
 * It reports rather than rewrites. Silently deleting a bad citation would hide
 * the very signal an editor needs: that this particular answer is not trustworthy.
 * See DECISIONS.md D-18.
 */

export interface CitationAudit {
  cited: string[];
  unresolved: string[];
  notRetrieved: string[];
  /** Cited now, retrieved on an earlier turn of this conversation. Legitimate. */
  carriedOver: string[];
  uncited: boolean;
  ok: boolean;
  warnings: string[];
}

const CITATION_RE = /\[([a-z_]+:\d+:\d+)\]/g;

export function auditCitations(
  answer: string,
  retrieved: Chunk[],
  /**
   * Passage ids cited earlier in this same conversation.
   *
   * Without this the audit fires on every conversational follow-up. Asking "in
   * bullet points" after a substantive answer needs no new retrieval. The model
   * reformats evidence it already has. And every citation was then reported as
   * unretrieved. The citations were real and had been audited when first
   * produced; the audit simply had no memory. A guardrail that cries wolf on
   * normal usage gets ignored, which is worse than not having it.
   */
  priorCited: Set<string> = new Set(),
  /**
   * Whether a passage id exists in the index. Injectable so the guardrail can
   * be unit-tested without a built index. A check nobody can run offline is a
   * check that rots. Defaults to the store, which is what the server uses.
   */
  exists: (id: string) => boolean = (id) => Boolean(store.get(id)),
): CitationAudit {
  const cited = [...new Set([...answer.matchAll(CITATION_RE)].map((m) => m[1]))];
  const retrievedIds = new Set(retrieved.map((c) => c.id));

  const unresolved = cited.filter((id) => !exists(id));
  const carriedOver = cited.filter(
    (id) => exists(id) && !retrievedIds.has(id) && priorCited.has(id),
  );
  const notRetrieved = cited.filter(
    (id) => exists(id) && !retrievedIds.has(id) && !priorCited.has(id),
  );

  // A refusal legitimately cites nothing. Only flag an answer that had evidence
  // available, is long enough to be making claims, and used none of it.
  const uncited = cited.length === 0 && retrieved.length > 0 && answer.length > 200;

  // A citation id is internal vocabulary. `little_women:12:4` told the reader
  // nothing and broke the rule the whole interface is built on (D-35), so the
  // warning names the book and chapter instead, and says what it means rather
  // than what the check is called.
  const readable = (id: string) => {
    const c = store.get(id);
    if (!c) return null;
    return `${c.bookTitle}, ${c.chapterTitle.replace(/\bCHAPTER\b/g, 'Chapter').replace(/\s*\.\s*$/, '')}`;
  };
  const names = (ids: string[]) => {
    const got = ids.map(readable).filter(Boolean) as string[];
    return [...new Set(got)].join('; ');
  };

  const warnings: string[] = [];
  if (unresolved.length) {
    warnings.push(
      `${unresolved.length === 1 ? 'A source' : `${unresolved.length} sources`} named in this answer ` +
        `${unresolved.length === 1 ? 'does' : 'do'} not exist in either book. Treat the answer as unverified.`,
    );
  }
  if (notRetrieved.length) {
    const where = names(notRetrieved);
    warnings.push(
      `This answer points at ${notRetrieved.length === 1 ? 'a passage' : 'passages'} the search did not ` +
        `return${where ? ` (${where})` : ''}, so ${notRetrieved.length === 1 ? 'it was' : 'they were'} ` +
        `written from memory rather than from evidence.`,
    );
  }
  if (uncited) {
    warnings.push('This answer makes claims without pointing at any passage, though passages were found.');
  }

  return {
    cited,
    unresolved,
    notRetrieved,
    carriedOver,
    uncited,
    ok: warnings.length === 0,
    warnings,
  };
}
