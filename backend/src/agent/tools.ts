import { BOOKS, config } from '../config.js';
import { chat, type ToolDef } from '../azure.js';
import type { Trace } from '../trace.js';
import type { Chunk } from '../ingest/chunk.js';
import { store } from '../retrieval/store.js';
import { retrieve } from '../retrieval/hybrid.js';
import { rerank } from '../retrieval/rerank.js';
import { expandOnEntities } from '../retrieval/expand.js';
import { findSimilarPassages, strengthOf, relationshipInWords } from '../retrieval/similar.js';
import { broadSearch } from '../retrieval/broaden.js';

/**
 * Tools the assistant can call.
 *
 * The assistant chooses; we do not route by keyword. "Compare how the two books
 * treat marriage" and "what does Jo say about writing" need different retrieval
 * shapes, and letting the model pick is the whole point of giving it tools.
 * See DECISIONS.md D-12.
 */

/**
 * Chapter and book notes from the summarise pass, loaded once. Absent is a
 * normal state. The tool says so rather than failing.
 */
const loadSummaries = () => store.notes();

const bookIds = BOOKS.map((b) => b.id);
const bookEnum = { type: 'string', enum: bookIds, description: `One of: ${bookIds.join(', ')}` };

export const toolDefs: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'search_books',
      description:
        'Search passages by meaning and keyword across the collection. Use for questions about ' +
        'characters, events, themes or specific wording. Returns passages with citation ids.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
          book: { ...bookEnum, description: 'Optional: restrict to one book.' },
          k: { type: 'number', description: 'How many passages to return (default 8, max 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'about_the_collection',
      description:
        'Facts about the collection ITSELF rather than what happens inside the books: which books ' +
        'these are, their authors, how long each one is in words, and how many chapters each has. ' +
        'Use for "how many words", "how long is it", "what books are these", "how many chapters".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'count_mentions',
      description:
        'Count how many times a LITERAL word, name or phrase appears in each book, with the ' +
        'chapters it appears in most. Use for "how many times is Longbourn mentioned", "how often ' +
        'does Darcy appear", "which book uses the word money more". This COUNTS the text, so the ' +
        'number is exact rather than an impression from a few passages. ' +
        'Do NOT use it for a CONCEPT or a category: "dramatic scenes", "arguments", "moments of ' +
        'jealousy" are not words in the text, and counting the word "drama" does not answer them. ' +
        'For those, search by subject and say plainly that no exact count exists.',
      parameters: {
        type: 'object',
        properties: {
          term: { type: 'string', description: 'The word, name or phrase to count. Case-insensitive.' },
          book: bookEnum,
        },
        required: ['term'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'survey_chapters',
      description:
        'Count how many CHAPTERS contain something that has to be judged rather than matched: ' +
        '"how many dramatic scenes", "how many arguments", "how many proposals", "how many deaths". ' +
        'Reads the note for every chapter of the book and decides for each one, so the answer covers ' +
        'the whole book rather than the passages a search happened to return. Give `looking_for` as ' +
        'a plain description of what counts. The result is a judgement at chapter granularity, not ' +
        'an exact scene count, and it says so.',
      parameters: {
        type: 'object',
        properties: {
          looking_for: {
            type: 'string',
            description: 'What counts, in plain words. "a heated argument between characters".',
          },
          book: bookEnum,
        },
        required: ['looking_for'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_by_subject',
      description:
        'Find passages about a SUBJECT rather than a phrase. Use when the reader names a topic and ' +
        'the books may not use that word: crime, money trouble, jealousy, illness. It expands the ' +
        'subject into several concrete searches covering different registers and fuses them, which ' +
        'ordinary search cannot do. Prefer search_books when the reader names a person, place or ' +
        'quotation.',
      parameters: {
        type: 'object',
        properties: { subject: { type: 'string', description: 'The topic, in the reader\'s words' }, book: bookEnum },
        required: ['subject'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'about_the_book',
      description:
        'What a whole book IS ABOUT, its overview and what happens in each chapter. Use for ' +
        '"what is this book about", "summarise it", "what happens in chapter X", "give me the shape ' +
        'of the story". These notes were written from the book\'s own text, so they cover the whole ' +
        'book. Prefer this over searching: eight passages cannot describe a novel.',
      parameters: { type: 'object', properties: { book: bookEnum }, required: ['book'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_chapters',
      description: 'List the chapters of a book, with their index and title. Use to orient before reading.',
      parameters: { type: 'object', properties: { book: bookEnum }, required: ['book'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_chapter',
      description:
        'Read a specific chapter in full. Use when the user asks about a named or numbered chapter, ' +
        'or when search results suggest one chapter needs reading end to end.',
      parameters: {
        type: 'object',
        properties: {
          book: bookEnum,
          chapter_index: { type: 'number', description: '0-based chapter index from list_chapters.' },
        },
        required: ['book', 'chapter_index'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_books',
      description:
        'Find passages in two different books that resemble each other, each with a plain-language ' +
        'reading of how strong the resemblance is and what kind it is. Use for questions about ' +
        'similarities, influence, parallels or overlap between authors.',
      parameters: {
        type: 'object',
        properties: {
          book_a: bookEnum,
          book_b: bookEnum,
          theme: {
            type: 'string',
            description: 'Optional: narrow the comparison to a theme, e.g. "marriage proposals".',
          },
          top_n: { type: 'number', description: 'How many pairs to return (default 5, max 10).' },
        },
        required: ['book_a', 'book_b'],
      },
    },
  },
];

export interface ToolResult {
  content: string;
  citedChunks: Chunk[];
}

const cite = (c: Chunk) => `[${c.id}] ${c.bookTitle}, ${c.chapterTitle}`;

const renderPassages = (chunks: Chunk[]) =>
  chunks.map((c) => `${cite(c)}\n${c.text}`).join('\n\n---\n\n');

/**
 * Which books the reader has in context. Retrieval is restricted to them, so a
 * question asked with one book selected cannot be answered from the other. The
 * selection is a real constraint, not a hint to the model.
 */
export async function runTool(
  name: string,
  args: any,
  trace: Trace,
  scope: string[] = BOOKS.map((b) => b.id),
): Promise<ToolResult> {
  const inScope = (id: string) => scope.includes(id);
  switch (name) {
    case 'search_books': {
      const want = Math.min(Number(args.k) || 8, 20);
      const useRerank = config.retrieval.rerank;
      // Over-fetch when reranking so the second pass has candidates to select
      // from. That is where the recall gain comes from, not from reordering.
      // A single book in scope is enforced here rather than trusted to the model.
      const only = args.book && inScope(args.book) ? args.book : scope.length === 1 ? scope[0] : undefined;
      let hits = await retrieve({
        query: String(args.query ?? ''),
        k: useRerank ? Math.max(want * 3, 24) : want,
        bookId: only,
        trace,
      });
      hits = hits.filter((h) => inScope(h.chunk.bookId));
      if (!hits.length) return { content: 'No passages matched that query.', citedChunks: [] };
      if (useRerank) hits = (await rerank(String(args.query ?? ''), hits, want, trace)) as typeof hits;

      // Multi-hop: chase rare names the results introduced but the query did not
      // contain. See expand.ts and DECISIONS.md D-31.
      const chunks = hits.map((h) => h.chunk);
      const extra = await expandOnEntities(String(args.query ?? ''), chunks, want, trace);
      const all = [...chunks, ...extra];
      return {
        content:
          renderPassages(chunks) +
          (extra.length
            ? `\n\n--- also found by following names in the passages above ---\n\n${renderPassages(extra)}`
            : ''),
        citedChunks: all,
      };
    }

    // A question about the collection is not a question about the text. Without
    // this the assistant searched the books for passages MENTIONING word counts,
    // found none, and reported that it could not answer, while the system knew
    // the exact figure. See DECISIONS.md D-42.
    case 'about_the_collection': {
      const lines = BOOKS.filter((b) => inScope(b.id)).map((b) => {
        const st = store.stats[b.id];
        return `${b.title} by ${b.author}: ${st.words.toLocaleString()} words, ` +
               `${st.chapters} chapters, indexed as ${st.chunks.toLocaleString()} searchable passages.`;
      });
      return {
        content: `The collection holds ${BOOKS.length} books.\n\n${lines.join('\n')}\n\n` +
          `These counts are of the text as indexed, with front and back matter excluded.`,
        citedChunks: [],
      };
    }

    /**
     * The third kind of counting (D-98).
     *
     * A word is arithmetic. A chapter is a fact of the parse. "How many dramatic
     * scenes" is neither: nothing in the book is labelled a scene, and dramatic
     * is a judgement. Retrieval cannot answer it either, because it returns the
     * eight most relevant passages and is built to FIND rather than ENUMERATE:
     * asking it how many is asking a sample to report a population.
     *
     * So the whole book is read instead, one chapter note at a time, and each is
     * judged against a description the reader supplied. That gives a real count
     * over real coverage, at chapter granularity, and the answer carries the
     * definition it used so the number can be argued with rather than believed.
     */
    case 'survey_chapters': {
      const looking = String(args.looking_for ?? '').trim();
      if (looking.length < 3) return { content: 'Tell me what to look for.', citedChunks: [] };
      const only = args.book && inScope(String(args.book)) ? String(args.book) : undefined;
      const notes = store.notes();
      if (!notes) return { content: 'The chapter notes are not available.', citedChunks: [] };

      const lines: string[] = [];
      for (const b of BOOKS) {
        if (!inScope(b.id) || (only && b.id !== only)) continue;
        const chapters = (notes.books?.[b.id]?.chapters ?? [])
          .filter((c: any) => store.isChapter(b.id, c.title));
        if (!chapters.length) continue;
        const listed = chapters
          .map((c: any) => `${c.index}. ${c.title.replace(/\s*\.\s*$/, '')}: ${c.summary}`)
          .join('\n');
        try {
          const { message } = await chat({
            messages: [
              {
                role: 'system',
                content:
                  'You are marking which chapters of a novel contain a thing, from their summaries.\n\n' +
                  'Return JSON: {"chapters": [0, 4, 11], "definition": "one sentence saying what you counted"}\n\n' +
                  'Include a chapter number only if its summary gives real reason to think the thing ' +
                  'is there. Do not include a chapter because the subject is generally present in the ' +
                  'book, and do not pad the list. A summary is short, so under-counting is expected ' +
                  'and better than guessing.',
              },
              { role: 'user', content: `LOOKING FOR: ${looking}\n\nCHAPTERS:\n${listed}` },
            ],
            jsonMode: true,
            maxTokens: 700,
            trace,
            label: `survey:${b.id}`,
          });
          const parsed = JSON.parse(message.content ?? '{}');
          const hits: number[] = (parsed.chapters ?? []).map(Number).filter((n: number) => !Number.isNaN(n));
          const named = hits
            .map((i) => chapters.find((c: any) => c.index === i)?.title?.replace(/\s*\.\s*$/, ''))
            .filter(Boolean);
          lines.push(
            `${b.title}: ${hits.length} of ${chapters.length} chapters. ` +
            (named.length ? `${named.slice(0, 8).join(', ')}${named.length > 8 ? `, and ${named.length - 8} more` : ''}.` : '') +
            (parsed.definition ? ` Counted as: ${parsed.definition}` : ''),
          );
        } catch {
          lines.push(`${b.title}: the survey did not complete.`);
        }
      }

      return {
        content:
          `Read every chapter note in full and judged each one.\n\n${lines.join('\n\n')}\n\n` +
          `This is a count of CHAPTERS containing the thing, judged from chapter summaries, not a ` +
          `count of scenes. Say so, and give the definition used, so the reader can disagree with it.`,
        citedChunks: [],
      };
    }

    /**
     * Counting is not searching, and asking a model to do it is asking it to
     * guess (D-94).
     *
     * "How many times is Longbourn mentioned" used to go to `search_books`,
     * which returned eight passages, from which the assistant honestly reported
     * that it could not give a count. Correct, and useless: the whole text is in
     * memory and counting it is free and exact. This is the same category error
     * D-42 fixed for word counts, in a different disguise. The answer is a
     * number, so it comes from arithmetic rather than from a language model.
     */
    case 'count_mentions': {
      const term = String(args.term ?? '').trim();
      if (term.length < 2) return { content: 'Give me a word or name to count.', citedChunks: [] };
      // Word-boundary where the term is wordlike, so "Meryton" does not match
      // inside another word and a phrase still matches as written.
      const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(/^\w[\w' -]*$/.test(term) ? `\\b${esc}\\b` : esc, 'gi');
      const only = args.book && inScope(String(args.book)) ? String(args.book) : undefined;

      const lines: string[] = [];
      for (const b of BOOKS) {
        if (!inScope(b.id) || (only && b.id !== only)) continue;
        const perChapter = new Map<number, { title: string; n: number }>();
        let total = 0;
        for (const c of store.chapters(b.id)) {
          const text = store.chapterText(b.id, c.index);
          const n = (text.match(re) ?? []).length;
          if (!n) continue;
          total += n;
          perChapter.set(c.index, { title: c.title, n });
        }
        if (!total) { lines.push(`${b.title}: "${term}" does not appear.`); continue; }
        const top = [...perChapter.values()].sort((x, y) => y.n - x.n).slice(0, 3);
        lines.push(
          `${b.title}: ${total} time${total === 1 ? '' : 's'}, across ${perChapter.size} ` +
          `chapter${perChapter.size === 1 ? '' : 's'}. Most often in ` +
          top.map((t) => `${t.title.replace(/\s*\.\s*$/, '')} (${t.n})`).join(', ') + '.',
        );
      }
      return {
        content: `Counted in the full text of each book.\n\n${lines.join('\n')}`,
        citedChunks: [],
      };
    }

    /**
     * A word is not a topic (D-53). "Crime" alone returns only Little Women,
     * because Alcott writes the word and Austen never does; her crime is an
     * elopement and a debt of honour. This was a button in the old interface.
     * On one screen the reader just asks, and the routing happens here (D-77).
     */
    case 'find_by_subject': {
      const book = args.book && inScope(String(args.book)) ? String(args.book) : undefined;
      const { phrases, hits } = await broadSearch({ query: String(args.subject), bookId: book, k: 6, trace });
      const scoped = hits.filter((h) => inScope(h.chunk.bookId));
      if (!scoped.length) return { content: `Nothing found on "${args.subject}".`, citedChunks: [] };
      return {
        content:
          `Searched ${phrases.length + 1} ways for "${args.subject}": the word itself, plus ` +
          `${phrases.join('; ')}.\n\n` +
          scoped.map((h) => `${cite(h.chunk)}\n${h.chunk.text}`).join('\n\n'),
        citedChunks: scoped.map((h) => h.chunk),
      };
    }

    /**
     * The gap the G1 eval cases found. Asked "what is Little Women about", the
     * assistant used to search for eight passages and write a whole-book summary
     * from them. Which is ungrounded by construction, because no eight passages
     * contain the shape of a novel. The judge caught it every time.
     *
     * The notes it now reads were generated from the complete text at ingest and
     * verified against it (D-43), so a whole-book answer rests on a whole-book
     * artefact. They carry no passage id, which is correct and not a weakness:
     * demanding a citation here is how a model learns to invent one.
     */
    case 'about_the_book': {
      const id = String(args.book);
      if (!inScope(id)) return { content: `${id} is not in view.`, citedChunks: [] };
      const book = BOOKS.find((b) => b.id === id);
      const notes = loadSummaries()?.books?.[id];
      if (!notes) {
        return {
          content: `No prepared notes for ${book?.title ?? id}. Run \`npm run summarise\`, or search the text instead.`,
          citedChunks: [],
        };
      }
      const chapters = (notes.chapters ?? [])
        .map((c: any) => `${c.title}: ${c.summary}`)
        .join('\n');
      return {
        content:
          `${book?.title} by ${book?.author}. NOTES, NOT TEXT: everything below is a summary this `+
          `system wrote from the book. None of it is the author's wording, so none of it may `+
          `be quoted. Use it to know what happens and to ground claims about the whole book. `+
          `Quote only passages returned by a search.\n\n` +
          `${notes.summary}\n\nChapter by chapter:\n${chapters}`,
        citedChunks: [],
      };
    }

    case 'list_chapters': {
      if (!inScope(String(args.book))) return { content: `${args.book} is not in view.`, citedChunks: [] };
      const chapters = store.chapters(String(args.book));
      if (!chapters.length) return { content: `Unknown book: ${args.book}`, citedChunks: [] };
      return {
        content: chapters.map((c) => `${c.index}. ${c.title}`).join('\n'),
        citedChunks: [],
      };
    }

    case 'read_chapter': {
      if (!inScope(String(args.book))) return { content: `${args.book} is not in view.`, citedChunks: [] };
      const parts = store.chapter(String(args.book), Number(args.chapter_index));
      if (!parts.length) {
        return { content: `No chapter ${args.chapter_index} in ${args.book}.`, citedChunks: [] };
      }
      // Chunks overlap by design; joining them raw repeats sentences at every
      // boundary and wastes context. store.chapterText deduplicates at sentence
      // level, see the note there on why suffix matching was not enough.
      const text = store.chapterText(String(args.book), Number(args.chapter_index));
      return {
        content: `${cite(parts[0])}\n\n${text}`,
        citedChunks: [parts[0]],
      };
    }

    case 'compare_books': {
      if (!inScope(String(args.book_a)) || !inScope(String(args.book_b))) {
        return {
          content: 'Both books must be in view to compare them. Ask the reader to add the second book.',
          citedChunks: [],
        };
      }
      const result = await findSimilarPassages({
        // Off by env only, so the cost of the judgement can be measured against
        // the answers it actually changes. See D-74.
        judge: (process.env.SIMILARITY_JUDGE ?? 'true') === 'true',
        bookA: String(args.book_a),
        bookB: String(args.book_b),
        theme: args.theme ? String(args.theme) : undefined,
        topN: Math.min(Number(args.top_n) || 5, 10),
        trace,
      });
      // The assistant is given the plain-language reading only. It never sees the
      // raw cosine or the internal category name, so it cannot quote either at an
      // editor. See DECISIONS.md D-36.
      const lines = result.pairs.map((p, i) => {
        const v = p.verdict;
        return (
          `## Pair ${i + 1}, ${strengthOf(p.similarity, result.baselineSimilarity)}\n` +
          `${cite(p.a)}\n${p.a.text.slice(0, 900)}\n\n` +
          `${cite(p.b)}\n${p.b.text.slice(0, 900)}\n\n` +
          (v
            ? `What they share: ${relationshipInWords(v.relationship)}. ${v.explanation}`
            : 'Not assessed.')
        );
      });
      // Two independent signals. The verbatim one is what distinguishes
      // "these scenes rhyme" from "someone copied a line".
      const v = result.verbatim;
      const verbatimNote = v.matches.length
        // Phrased as a finding to report rather than a sentence to quote. The
        // earlier wording read like quotable prose and the assistant duly put it
        // in quotation marks, attributing this system's own sentence to a
        // novelist. See D-66.
        ? `WORDING CHECK (a result, not a quotation): some exact wording is shared. ` +
          `Clearest instance: ${v.matches[0].phrase}`
        : `WORDING CHECK (a result, not a quotation): zero shared phrases were found between ` +
          `these books. Tell the reader in your own words that the resemblance is in subject or ` +
          `structure and that no writing is copied. Do not put this sentence in quotation marks.`;

      return {
        content:
          `Compared every passage in one book against every passage in the other. ` +
          `Both are 19th-century domestic novels, so a family resemblance is expected; ` +
          `what follows is only what stands out ABOVE that.\n\n` +
          `${verbatimNote}\n\n` +
          lines.join('\n\n---\n\n'),
        citedChunks: result.pairs.flatMap((p) => [p.a, p.b]),
      };
    }

    default:
      return { content: `Unknown tool: ${name}`, citedChunks: [] };
  }
}
