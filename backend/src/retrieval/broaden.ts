import { chat } from '../azure.js';
import { Trace } from '../trace.js';
import { retrieve } from './hybrid.js';
import type { Chunk } from '../ingest/chunk.js';
import { config } from '../config.js';

/**
 * Topic search: one abstract word becomes several concrete searches.
 *
 * WHY THIS EXISTS. A single query, dense or sparse, matches the register the
 * reader typed in. Search "crime" and you get Little Women, because Alcott
 * writes the word (Jo "searched newspapers for accidents, incidents, and
 * crimes") and Austen never does. Pride and Prejudice's crime is an elopement,
 * debts of honour and seduction, and none of those embed near "crime" strongly
 * enough to beat a passage that says it outright. The retrieval is behaving
 * correctly and the answer is still wrong for the reader.
 *
 * The assistant already solved this for itself: given the same question it
 * searched "scandal elopement debts gambling militia" in one book and "theft
 * punishment dishonest behaviour" in the other. This puts the same move behind
 * the direct search, as a step the reader asks for rather than one that happens
 * silently, see DECISIONS.md D-53.
 *
 * NO BOOK KNOWLEDGE. The model expands the TOPIC, never the books: no character
 * names, no plot. That is not squeamishness, it is the same constraint as the
 * chapter summaries (D-43). This has to work on a manuscript nobody has read,
 * and a system that finds Wickham because it remembers Wickham finds nothing in
 * an unpublished submission.
 */

const SYSTEM = `You turn a topic into search phrases for a full-text search of nineteenth-century novels.

Return JSON: {"phrases": ["...", "..."]}

Four or five short phrases. Between them they must cover the DIFFERENT REGISTERS in which a novel
might treat this topic, because two novels rarely treat it the same way:

  - the act itself, in plain period words
  - its social consequence, disgrace, reputation, scandal, being talked of
  - its material consequence, debts, ruin, being sent away, loss of a place
  - the moral words a character would use about it, sin, wickedness, shame, folly

A quiet domestic novel may never use your topic word once, and will still be full of the thing.
Searching only for the official machinery of a topic (for "crime": constable, magistrate, gaol) is
the classic way to miss it. That vocabulary belongs to a different kind of book.

Spread the phrases: two that mean the same thing waste a search.

Do NOT name characters, places or events from any book you may know. You are expanding the topic,
not recalling a story. The search decides what is actually in the books; your job is only to give it
better words to look for.`;

export interface BroadHit {
  chunk: Chunk;
  score: number;
  /** Which phrases found this passage. Shown to the reader instead of a rank. */
  via: string[];
}

/** Phrases for a topic. Falls back to the reader's own words if the call fails. */
export async function phrasesFor(query: string, trace?: Trace): Promise<string[]> {
  try {
    const { message } = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: query },
      ],
      jsonMode: true,
      maxTokens: 300,
      trace,
      label: 'broaden',
    });
    const parsed = JSON.parse(message.content ?? '{}');
    const phrases = (parsed.phrases ?? [])
      .map((p: unknown) => String(p ?? '').trim())
      .filter((p: string) => p.length > 2)
      .slice(0, 5);
    return phrases.length ? phrases : [];
  } catch {
    return [];
  }
}

/**
 * Runs the reader's query alongside each expanded phrase, then takes the best
 * result from each in turn.
 *
 * NOT summed RRF, which is what this did first and got wrong. Summing rewards a
 * passage matched by MANY phrases, so the winners are whichever register the
 * phrases happen to agree on. And the ranking collapses back onto the book
 * whose prose is most explicit, which is the exact failure the expansion was
 * built to fix. Searching "crime", summing returned five Little Women passages;
 * the register that actually carries crime in Pride and Prejudice is a debt and
 * an elopement, and it matched one phrase strongly rather than four weakly.
 *
 * Round-robin instead: each phrase contributes its best unseen passage before
 * any phrase contributes a second. The expansion exists to cover registers, so
 * the fusion has to preserve that rather than average it away.
 *
 * This is not the interleaving refused in D-51. That was interleaving by BOOK,
 * which would have hidden a real finding about the collection. This interleaves
 * by QUERY, and the queries were deliberately made different from each other.
 */
export async function broadSearch(opts: {
  query: string;
  bookId?: string;
  k?: number;
  trace?: Trace;
}): Promise<{ phrases: string[]; hits: BroadHit[] }> {
  const k = opts.k ?? config.retrieval.k;
  const phrases = await phrasesFor(opts.query, opts.trace);
  const queries = [opts.query, ...phrases];

  const lists = await Promise.all(
    queries.map((q) => retrieve({ query: q, bookId: opts.bookId, k: 12, trace: opts.trace })),
  );

  // Every passage any phrase found, with the phrases that found it.
  const via = new Map<string, string[]>();
  lists.forEach((list, li) => {
    list.forEach((hit) => {
      const cur = via.get(hit.chunk.id) ?? [];
      cur.push(queries[li]);
      via.set(hit.chunk.id, cur);
    });
  });

  // Round-robin: each query's best unseen passage, then each query's second.
  // One passage per chapter, because five results is a short list and a chapter
  // taking two of them buys nothing the reader cannot get by opening it.
  const hits: BroadHit[] = [];
  const takenChunks = new Set<string>();
  const takenChapters = new Set<string>();
  const depth = Math.max(...lists.map((l) => l.length));
  for (let rank = 0; rank < depth && hits.length < k; rank++) {
    for (const list of lists) {
      if (hits.length >= k) break;
      const hit = list[rank];
      if (!hit || takenChunks.has(hit.chunk.id)) continue;
      const chapter = `${hit.chunk.bookId}:${hit.chunk.chapterIndex}`;
      if (takenChapters.has(chapter)) continue;
      takenChunks.add(hit.chunk.id);
      takenChapters.add(chapter);
      hits.push({ chunk: hit.chunk, score: 1 / (rank + 1), via: via.get(hit.chunk.id) ?? [] });
    }
  }

  return { phrases, hits };
}
