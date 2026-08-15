import { useEffect, useRef, useState } from 'react';

/**
 * One screen, three columns: saved conversations, the conversation, the books.
 *
 *   left    threads, kept in localStorage, and where identity would go
 *   centre  the conversation, which is the whole product
 *   right   what a question can reach, and the way into reading a chapter
 *
 * This replaced a two-surface app with a Library you navigated to. On one screen
 * the books stop being a destination and become the context panel for the
 * conversation, which is what they always were in practice: look something up,
 * then ask about it. Reading is still a deliberate act (D-47), now a full-screen
 * reader opened from the right column.
 *
 * Two rules learned the hard way and enforced throughout:
 *   1. Never show a number the reader cannot act on.
 *   2. Never show internal vocabulary. Translate at the boundary.
 */

interface Chunk {
  id: string; bookId: string; bookTitle: string; author: string;
  chapterTitle: string; chapterIndex: number; text: string;
}
interface TraceSummary {
  traceId: string; totalMs: number;
  spans: { name: string; ms: number }[];
  usage: { promptTokens: number; completionTokens: number; embeddingTokens: number };
  estimatedCostUsd: number;
}
interface Book { id: string; title: string; author: string; chapters: number; chunks: number }

const get = async (u: string) => {
  const r = await fetch(u);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `Failed (${r.status})`);
  return r.json();
};
const post = async (u: string, body: unknown) => {
  const r = await fetch(u, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error ?? `Failed (${r.status})`);
  return j;
};

/* ─────────────────────── highlighting ─────────────────────── */

const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Marks the phrases the caller names, and leaves everything else alone.
 * What a span MEANS is the caller's business: the passage panel marks the words
 * the answer quoted out of this passage.
 */
function Highlight({ text, spans = [], spanClass = 'echo' }:
  { text: string; spans?: string[]; spanClass?: string }) {
  if (!spans.length) return <>{text}</>;
  return (
    <>
      {text.split(new RegExp(`(${spans.map(esc).join('|')})`, 'g')).map((part, i) =>
        spans.includes(part)
          ? <mark className={spanClass} key={i}>{part}</mark>
          : <span key={i}>{part}</span>)}
    </>
  );
}

/* ─────────────────────── shared pieces ─────────────────────── */

/**
 * The password screen for the hosted demo.
 *
 * Only ever rendered when the server says it is locked, which it only says when
 * a password is configured. Running locally there is no gate and this never
 * appears. It asks for a password rather than an account because the question is
 * whether this person may use it, not who they are.
 */
function Unlock({ onOpen }: { onOpen: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await post('/api/unlock', { password: pw });
      onOpen();
    } catch (x) {
      setErr((x as Error).message || 'That password is not right.');
    } finally { setBusy(false); }
  };

  return (
    <div className="unlock">
      <form className="unlock-card" onSubmit={submit}>
        <div className="brand-mark">E</div>
        <h1>Editorial Assistant</h1>
        <p>Ask grounded questions about two novels, and see the passage behind every answer.</p>
        <input type="password" value={pw} autoFocus placeholder="Password"
               aria-label="Password" onChange={(e) => setPw(e.target.value)} />
        <button type="submit" disabled={busy || !pw}>{busy ? 'Checking' : 'Open'}</button>
        {err && <p className="err">{err}</p>}
      </form>
    </div>
  );
}



/** The chapter's number, however each book writes it. */
/**
 * Gutenberg shouts. "CHAPTER XVII." beside "Chapter I." is the source being
 * inconsistent with itself, and neither belongs in a reader's chapter list.
 */
const tidyTitle = (title: string) =>
  title.replace(/\bCHAPTER\b/g, 'Chapter').replace(/\s*\.\s*$/, '').trim();

const chapterRef = (title: string) => {
  const m = title.match(/\b([IVXLC]+|\d+)\b/i);
  return m ? m[1].toUpperCase() : title.replace(/^chapter\s*/i, '').slice(0, 10);
};

/**
 * The chapter title without its leading numeral, which the folio already shows.
 *
 * Returns empty rather than falling back to the full title. Pride and Prejudice
 * names its chapters "CHAPTER II." and nothing else, so the fallback printed
 * "II  CHAPTER II." on every row. An empty string lets the folio speak alone,
 * which is what it is for.
 */
const stripRef = (title: string) =>
  title.replace(/^\s*(?:chapter\s+)?[IVXLC\d]+[.:]?\s*/i, '').trim();

/**
 * A short label for a chapter that has no title.
 *
 * Austen numbers her chapters and does not name them, so the panel showed a
 * column of bare roman numerals with nothing to distinguish them. The opening
 * of the chapter note is the only thing that says what is in there.
 */
const firstClause = (note?: string) => {
  if (!note) return '';
  // Truncated on a word boundary rather than split on a sentence. Splitting on
  // "." made every Austen chapter label read "Mrs." or "Mr.", because these
  // novels open on a name and an abbreviation ends in a full stop. The same
  // trap the chunker fell into (D-62), reached from a different direction.
  const clean = note.replace(/\s+/g, ' ').trim();
  return clean.length > 58 ? `${clean.slice(0, 58).replace(/[\s,;:.]+\S*$/, '')}…` : clean;
};

function Trace({ trace }: { trace?: TraceSummary }) {
  if (!trace) return null;
  const tokens = trace.usage.promptTokens + trace.usage.completionTokens;
  return (
    <details className="raw">
      <summary>Timings and cost</summary>
      <div className="trace">
        {trace.spans.map((s, i) => <span key={i}>{s.name} <b>{s.ms}ms</b></span>)}
        <span>total <b>{(trace.totalMs / 1000).toFixed(1)}s</b></span>
        {tokens > 0 && <span>{tokens.toLocaleString()} tok</span>}
        {trace.estimatedCostUsd > 0 && <span>${trace.estimatedCostUsd.toFixed(4)}</span>}
      </div>
    </details>
  );
}

/**
 * An answer, rendered as blocks rather than one run of text.
 *
 * The model is asked for headings and paragraphs when it answers two books
 * separately; rendering everything into a single element collapsed all of that
 * into a wall, so the structure it was asked for never reached the reader.
 * Deliberately not a markdown library: headings, paragraphs, bullets and bold
 * are the whole vocabulary, and citations have to survive the parse.
 */
/** Punctuation the model and Gutenberg disagree about, flattened for matching. */
const flatten = (t: string) =>
  t.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ').trim();

function Answer({ text, onPick, active, citations, openText }:
  { text: string; onPick: (id: string) => void; active: string | null; citations: Chunk[];
    openText?: string }) {
  const by = new Map(citations.map((c) => [c.id, c]));
  // When a passage is open on the right, the words in the answer that came out
  // of it are marked here too. Reading a citation used to mean finding the
  // sentence again by eye in a wall of prose; now both ends light up together.
  const openFlat = openText ? flatten(openText) : '';
  // The same test the panel applies, so both ends agree on what counts. They
  // disagreed once: the panel took any quotation of twelve characters and this
  // wanted four words, so "That's a fib!" lit up on the right and not in the
  // answer. A mark that appears on one side of a pair is worse than no mark,
  // because the reader concludes the two are different things.
  const fromOpen = (quoted: string) => {
    if (!openFlat) return false;
    const inner = flatten(quoted).replace(/^["']|["']$/g, '').trim();
    return inner.length >= 12 && openFlat.includes(inner);
  };

  const inline = (s: string, key: string) =>
    // The range form is real: the model cites [book:12:4-5] when a claim spans
    // two adjacent passages. Unhandled, it printed the raw id in the prose.
    s.split(/(\[[a-z_]+:\d+:\d+(?:-\d+)?\]|\*\*[^*]+\*\*|\u201C[^\u201D]+\u201D)/g).map((part, i) => {
      const bold = part.match(/^\*\*([^*]+)\*\*$/);
      if (bold) return <b key={`${key}-${i}`}>{bold[1]}</b>;
      // A marker the model invented for a source that has no passage id, like
      // "[collection facts]" or "[count]". The prompt forbids it; this makes
      // sure a slip is not printed to the reader verbatim (D-101).
      if (/^\[(collection facts|count|counts|chapter notes|notes|survey|comparison)\]$/i.test(part.trim())) {
        return null;
      }
      if (/^\u201C[^\u201D]+\u201D$/.test(part)) {
        return <span key={`${key}-${i}`} className={fromOpen(part) ? 'from-open' : undefined}>{part}</span>;
      }
      const m = part.match(/^\[([a-z_]+:\d+:\d+)(?:-\d+)?\]$/);
      if (!m) return <span key={`${key}-${i}`}>{part}</span>;
      const c = by.get(m[1]);
      // A range whose first passage was not retrieved is not a citation the
      // reader can open, so it is dropped rather than shown as a dead chip.
      if (!c) return null;
      const label = c ? `${c.bookId === 'little_women' ? 'LW' : 'PP'} ${chapterRef(c.chapterTitle)}` : 'source';
      return (
        <button key={`${key}-${i}`} className="cite" data-active={active === m[1]}
                onClick={() => onPick(m[1])}
                title={c ? `${c.bookTitle}, ${c.chapterTitle}` : 'Read this passage'}>
          {label}
        </button>
      );
    });

  const blocks = text.trim().split(/\n{2,}/);

  return (
    <div className="prose">
      {blocks.map((block, b) => {
        const lines = block.split('\n').filter((l) => l.trim());
        const head = lines[0]?.match(/^#{1,4}\s+(.*)$/) ?? lines[0]?.match(/^\*\*(.+)\*\*:?$/);
        // A heading on its own line, with the rest of the block under it.
        if (head && lines.length === 1) return <h4 key={b}>{head[1]}</h4>;
        if (head) {
          return (
            <div key={b}>
              <h4>{head[1]}</h4>
              <p>{inline(lines.slice(1).join(' '), `${b}`)}</p>
            </div>
          );
        }
        if (lines.every((l) => /^\s*[-*]\s+/.test(l))) {
          return (
            <ul key={b}>
              {lines.map((l, i) => <li key={i}>{inline(l.replace(/^\s*[-*]\s+/, ''), `${b}-${i}`)}</li>)}
            </ul>
          );
        }
        const joined = lines.join(' ');
        // A paragraph that is almost entirely one quotation is the book
        // speaking, and setting it apart is what makes an answer scannable.
        const solo = joined.match(/^[\s]*[“"]([^”"]{60,})[”"][\s]*(\[[a-z_]+:\d+:\d+(?:-\d+)?\])?[\s.]*$/);
        if (solo) {
          return (
            <blockquote key={b} data-open={fromOpen(solo[1]) || undefined}>
              {inline(solo[1], `${b}`)}
              {solo[2] ? <div className="bq-src">{inline(solo[2], `${b}s`)}</div> : null}
            </blockquote>
          );
        }
        return <p key={b}>{inline(joined, `${b}`)}</p>;
      })}
    </div>
  );
}

/* ────────────────────────────── Read ────────────────────────────── */

/**
 * Two-page reader. Pagination rather than a scroll, because the research on
 * reading interfaces finds pages help a reader build a mental map and RELOCATE a
 * passage. Which is an editor's actual job. Implemented with CSS columns at a
 * fixed height, advanced by translating the column track, so the underlying text
 * is untouched and search and citations never depend on where a page breaks.
 */
function Reader({ book, chapter, chapters, onClose, onMove }:
  { book?: Book; chapter: any; chapters: { index: number; title: string }[];
    onClose: () => void; onMove: (i: number) => void }) {
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [step, setStep] = useState(0);
  const [cols, setCols] = useState(2);
  const track = useRef<HTMLDivElement>(null);

  /**
   * Measured, not assumed. A spread advances by one column plus one gap, per
   * column on screen. And the columns are laid out inside the padding, so the
   * element's own width is the wrong number to move by. Hardcoding it left the
   * first page clipped and a sliver of the next one showing.
   */
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const cs = getComputedStyle(el);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.columnGap) || 0;
    const cols = parseInt(cs.columnCount, 10) || 1;
    const content = el.clientWidth - padX;
    const unit = (content - gap * (cols - 1)) / cols + gap;   // one column + its gap
    const total = Math.max(1, Math.round((el.scrollWidth - padX + gap) / unit));
    setStep(unit * cols);
    setCols(cols);
    setPages(Math.max(1, Math.ceil(total / cols)));
  };

  useEffect(() => { setPage(0); const t = setTimeout(measure, 60); return () => clearTimeout(t); }, [chapter?.index]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') setPage((p) => Math.min(p + 1, pages - 1));
      if (e.key === 'ArrowLeft') setPage((p) => Math.max(p - 1, 0));
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [pages, onClose]);

  // role="dialog" is a promise about focus, and it was only a label. Opening the
  // reader left focus behind on the button in the column underneath, so the next
  // Tab walked the page behind the overlay and Escape was the only way out for
  // anyone not using a mouse.
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    shell.current?.focus();
  }, [chapter?.index]);

  if (!chapter) return null;
  const atStart = page === 0;
  const atEnd = page >= pages - 1;

  return (
    <div className="reader" role="dialog" aria-modal="true" tabIndex={-1} ref={shell}
         aria-label={`Reading ${chapter.title}`}>
      <div className="reader-bar">
        <span className="meta">{book?.title}</span>
        {/* Jump straight to a chapter: 49 of them is too many to page through. */}
        <select value={chapter.index} onChange={(e) => onMove(Number(e.target.value))}
                aria-label="Go to chapter">
          {chapters.map((c) => (
            <option key={c.index} value={c.index}>{tidyTitle(c.title)}</option>
          ))}
        </select>
        <span className="grow" />
        <button className="shut" onClick={onClose}>Close</button>
      </div>

      <div className="spread">
        <div className="pages" ref={track}
             style={{ transform: `translateX(${-page * step}px)` }}>
          {chapter.text.split('\n\n').map((p: string, i: number) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      </div>

      <div className="reader-foot">
        <button disabled={atStart && chapter.prev === null}
                onClick={() => (atStart ? onMove(chapter.prev) : setPage((p) => p - 1))}>
          ← {atStart ? 'Previous chapter' : 'Back'}
        </button>
        <span>{cols > 1 ? 'spread' : 'page'} {page + 1} of {pages}</span>
        <button disabled={atEnd && chapter.next === null}
                onClick={() => (atEnd ? onMove(chapter.next) : setPage((p) => p + 1))}>
          {atEnd ? 'Next chapter' : 'Forward'} →
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────── Ask ────────────────────────────── */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  question?: string;
  citations?: Chunk[];
  steps?: { tool: string; args: any }[];
  trace?: TraceSummary;
  audit?: { ok: boolean; warnings: string[]; unresolved?: string[]; notRetrieved?: string[]; uncited?: boolean };
  claims?: {
    checked: number;
    misquoted: string[];
    unsupported: { claim: string; missing: string }[];
    inferences: { claim: string; missing: string }[];
    recovered: { claim: string }[];
    extraCitations: Chunk[];
  };
}

/**
 * One conversation. Persisted to localStorage so a thread survives a reload,
 * which is what every chat tool does and what an editor coming back to a
 * half-finished question expects. Nothing is sent anywhere: there is no server
 * to send it to, and pretending otherwise would be the wrong signal (see the
 * README on what multi-user would actually take).
 */
interface Thread {
  id: string;
  title: string;
  at: number;
  turns: Turn[];
  scope: string[];
}

/** What the assistant actually did, in words, before any raw numbers. */
function Provenance({ turn }: { turn: Turn }) {
  const cites = turn.citations ?? [];
  const steps = turn.steps ?? [];
  if (!steps.length && !cites.length) return null;

  const title = (b: string) => (b === 'little_women' ? 'Little Women' : 'Pride and Prejudice');
  const chapters = [...new Set(cites.map((c) => `${c.bookTitle} · ${c.chapterTitle}`))];
  const books = [...new Set(cites.map((c) => c.bookTitle))];
  const label = (s: { tool: string; args: any }) =>
    s.tool === 'search_books' ? `searched for “${s.args.query}”${s.args.book ? ` in ${title(s.args.book)}` : ''}`
    : s.tool === 'compare_books' ? `compared ${title(s.args.book_a)} with ${title(s.args.book_b)}`
    : s.tool === 'read_chapter' ? `read a chapter of ${title(s.args.book)}`
    : `looked over the contents of ${title(s.args.book)}`;

  return (
    <div className="provenance">
      <b>How this answer was produced</b>
      {/* A follow-up that can be answered from what is already on screen calls no
          tool, and this rendered as a heading above an empty list. Say what
          happened instead: the reader needs to know the answer rests on passages
          fetched earlier rather than on a fresh look at the books. */}
      {steps.length > 0
        ? <ol>{steps.map((s, i) => <li key={i}>{label(s)}</li>)}</ol>
        : <p style={{ margin: '4px 0 0' }}>
            No new search was needed. This answer builds on the passages already
            retrieved earlier in this conversation.
          </p>}
      {cites.length > 0 && (
        <div style={{ marginTop: 6 }}>
          Grounded in <b>{cites.length} {cites.length === 1 ? 'passage' : 'passages'}</b> across{' '}
          <b>{chapters.length}</b> {chapters.length === 1 ? 'chapter' : 'chapters'}
          {books.length > 1 ? ' in both books' : books.length === 1 ? ` in ${books[0]}` : ''}.{' '}
          Select any citation above to read the passage behind it.
        </div>
      )}
    </div>
  );
}

/**
 * Reader feedback. A thumbs-down asks which half failed, because that maps onto
 * the two things the eval measures separately. And every downvote is written
 * out as a candidate test case. A complaint becomes a regression test.
 */
function Rate({ turn }: { turn: Turn }) {
  const [sent, setSent] = useState<'up' | 'down' | null>(null);
  const [asking, setAsking] = useState(false);

  const send = (verdict: 'up' | 'down', fault?: string) => {
    post('/api/feedback', {
      verdict, fault, question: turn.question ?? '', answer: turn.content,
      citedIds: (turn.citations ?? []).map((c) => c.id), traceId: turn.trace?.traceId,
    }).catch(() => {});
    setSent(verdict);
    setAsking(false);
  };

  if (sent === 'up') return <div className="rate"><span className="thanks">Noted, thank you.</span></div>;
  if (sent === 'down') return <div className="rate"><span className="thanks">Logged as a case to fix. Thank you.</span></div>;

  return (
    <>
      <div className="rate">
        <span className="lbl">Was this answer useful?</span>
        <button onClick={() => send('up')}>Yes</button>
        <button data-on={asking} onClick={() => setAsking(true)}>No</button>
      </div>
      {asking && (
        <div className="fault">
          What was wrong with it?
          <div className="row">
            <button className="chip" onClick={() => send('down', 'retrieval')}>It looked in the wrong place</button>
            <button className="chip" onClick={() => send('down', 'writing')}>It found the right part but got the answer wrong</button>
            <button className="chip" onClick={() => send('down', 'other')}>Something else</button>
          </div>
        </div>
      )}
    </>
  );
}

function Ask({ books, thread, onThread, onPick, pinned, onHelp }: {
  books: Book[];
  thread: Thread;
  onThread: (patch: Partial<Thread> | ((t: Thread) => Partial<Thread>)) => void;
  onPick: (id: string | null) => void;
  pinned: string | null;
  onHelp: () => void;
}) {
  const scope = thread.scope;
  const setScope = (v: string[] | ((s: string[]) => string[])) =>
    onThread({ scope: typeof v === 'function' ? v(thread.scope) : v });
  // With two books in view the reader chooses what "both" means: one comparison,
  // or the same question answered separately for each. Without this the mode was
  // implicit and nobody could tell it had changed.
  const turns = thread.turns;
  // Resolved inside the store, not against the props captured at render: a turn
  // appends the question and then the answer, and reading `thread.turns` twice
  // from the same render made the answer overwrite the question.
  const setTurns = (v: Turn[] | ((t: Turn[]) => Turn[])) =>
    onThread((cur) => ({ turns: typeof v === 'function' ? v(cur.turns) : v }));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [live, setLive] = useState<string[]>([]);
  const end = useRef<HTMLDivElement>(null);

  /**
   * Where to be when an answer lands.
   *
   * It used to jump to the very bottom, which put the reader at the end of a
   * long answer looking at the checks and the trace before they had read a word
   * of it. That reads as a wall of warnings rather than an answer with
   * apparatus under it.
   *
   * Now: while the search is running, follow the progress lines, because that is
   * the only thing moving. When the answer arrives, put the TOP of it at the top
   * of the view, so it is read from the beginning and the apparatus is reached
   * in the order it belongs. If the reader has scrolled away, nothing moves;
   * taking the view back from someone who took it is the rudest thing an
   * interface can do.
   */
  const lastAnswer = useRef<HTMLDivElement>(null);
  const held = useRef(false);
  useEffect(() => {
    // The scrolling element is the column, not the .chat block inside it, so
    // this listener never fired and "don't take the view back" never applied.
    const el = document.querySelector('.col-chat');
    if (!el) return;
    const onScroll = () => {
      held.current = el.scrollHeight - el.scrollTop - el.clientHeight > 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (busy) { if (!held.current) end.current?.scrollIntoView({ behavior: 'smooth' }); return; }
    if (held.current) return;
    lastAnswer.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [turns, busy]);
  useEffect(() => { if (!scope.length && books.length) setScope(books.map((b) => b.id)); }, [books, scope.length]);

  const pick = (id: string) => onPick(id === pinned ? null : id);

  const send = async () => {
    const q = input.trim();
    if (!q || busy) return;
    setInput(''); setErr('');
    const history = [...turns.map(({ role, content }) => ({ role, content })), { role: 'user' as const, content: q }];
    setTurns((t) => [...t, { role: 'user', content: q }]);
    setBusy(true);
    setLive(['Reading your question']);
    try {
      // Streamed: a turn takes 10-20s and the model is silent for most of it
      // while searches run. Each event is something that actually happened.
      const res = await fetch('/api/chat/stream', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, books: scope }),
      });
      if (!res.body) throw new Error('Streaming is not supported by this browser.');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let tooled = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === 'progress') {
            if (ev.kind === 'tool') { tooled = true; setLive((l) => [...l, ev.detail]); }
            else if (ev.kind === 'writing') {
              // A follow-up answerable from what has already been found calls no
              // tool, so the reader saw "Reading your question" then "Writing the
              // answer" and nothing that said what was being used. Say it.
              setLive((l) => [...l,
                ...(tooled ? [] : ['Using the passages already found']), 'Writing the answer']);
            }
          } else if (ev.type === 'done') {
            const r = ev.result;
            setTurns((t) => [...t, {
              role: 'assistant', content: r.answer, question: q, citations: r.citations,
              steps: r.steps, trace: r.trace, audit: r.audit, claims: r.claims,
            }]);
          } else if (ev.type === 'error') {
            setErr(ev.error);
          }
        }
      }
    } catch (e) {
      // "Failed to fetch" is what the browser says when the backend is not
      // running. It is accurate and it tells an editor nothing they can act on.
      const raw = (e as Error).message ?? '';
      setErr(/failed to fetch|networkerror|load failed/i.test(raw)
        ? 'Could not reach the assistant. Check that the server is running, then ask again.'
        : raw || 'Something went wrong. Try asking again.');
    }
    finally { setBusy(false); setLive([]); }
  };

  const all = turns.flatMap((t) => t.citations ?? []);
  const shown = pinned ? all.find((c) => c.id === pinned) : undefined;
  const answers = turns.filter((t) => t.role === 'assistant');
  // The third answer, and only that one.
  const lastRated = answers.length === 3 ? turns.lastIndexOf(answers[2]) : -1;

  return (
    <div className="chat">

          {turns.length === 0 && (
            <div className="card card-pad opening">
              <p className="lede">
                Ask in plain words about the books listed on the right. Every answer is built from
                passages in them, and each one is marked so you can open it and check.
              </p>

              <p className="tries-head">Try one of these</p>
              <ul className="tries">
                <li>
                  <span className="does">Understand a book</span>
                  <button onClick={() => setInput('What is Little Women about?')}>
                    What is Little Women about?
                  </button>
                </li>
                <li>
                  <span className="does">Answer about a scene</span>
                  <button onClick={() => setInput('Why does Elizabeth refuse Mr Collins?')}>
                    Why does Elizabeth refuse Mr Collins?
                  </button>
                </li>
                <li>
                  <span className="does">Find passages on a subject</span>
                  <button onClick={() => setInput('Find passages about money and inheritance')}>
                    Find passages about money and inheritance
                  </button>
                </li>
                <li>
                  <span className="does">Count across a book</span>
                  <button onClick={() => setInput('How many chapters have a dramatic confrontation?')}>
                    How many chapters have a dramatic confrontation?
                  </button>
                </li>
                <li>
                  <span className="does">Compare the two</span>
                  <button onClick={() => setInput('Do these books share any copied wording, or only themes?')}>
                    Do these books share any copied wording, or only themes?
                  </button>
                </li>
              </ul>

              <p className="hint" style={{ margin: 0 }}>
                The books on the right are what a question can reach. Untick one to ask about the
                other alone. Select any <span className="cite-demo">PP XIX</span> in an answer to
                open that passage beside it, and read the whole chapter from there.
                {' '}
                <button className="linkish" onClick={onHelp}>How it works</button> covers the rest,
                including what each kind of question costs.
              </p>
            </div>
          )}

          {turns.map((t, i) => (
            <div className="exchange" key={i} data-role={t.role}>
              {t.role === 'user'
                ? <div className="ask">{t.content}</div>
                : (
                  <div className="card card-pad"
                       ref={i === turns.length - 1 ? lastAnswer : undefined}>
                    <Answer text={t.content} citations={t.citations ?? []}
                            onPick={pick} active={pinned} openText={shown?.text} />
                    {/* Three outcomes the backend already ranks and the interface
                        used to flatten into one box. A fabricated source is not
                        the same event as an answer that leant on memory, and a
                        reader deciding whether to trust this needs to know which
                        one happened. Same reasoning as D-63 for claims. */}
                    {t.audit && !t.audit.ok && (t.audit.unresolved?.length ?? 0) > 0 && (
                      <div className="mark">
                        <strong>A source in this answer does not exist</strong>
                        <ul>
                          {t.audit.warnings
                            .filter((w) => /do(es)? not exist/.test(w))
                            .map((w, j) => <li key={j}>{w}</li>)}
                        </ul>
                      </div>
                    )}
                    {t.audit && !t.audit.ok
                      && ((t.audit.notRetrieved?.length ?? 0) > 0 || t.audit.uncited) && (
                      <div className="note aside">
                        <strong>Worth checking</strong>
                        <ul>
                          {t.audit.warnings
                            .filter((w) => !/do(es)? not exist/.test(w))
                            .map((w, j) => <li key={j}>{w}</li>)}
                        </ul>
                      </div>
                    )}
                    {/* Sentence-level check, in two kinds, because they are not
                        the same event. A statement no passage supports is a
                        defect. A judgement the reader asked for is not, and
                        showing both in the same alarm colour taught the reader
                        to discount both. */}
                    {/* A misquotation is the most serious of the three: it puts
                        words in an author's mouth, and it is decided by string
                        comparison rather than judgement. */}
                    {t.claims && t.claims.misquoted.length > 0 && (
                      <div className="mark">
                        <strong>
                          {t.claims.misquoted.length === 1 ? 'A quotation does' : `${t.claims.misquoted.length} quotations do`}
                          {' '}not appear in the passages
                        </strong>
                        <ul>
                          {t.claims.misquoted.map((q, j) => <li key={j}><q>{q}</q></li>)}
                        </ul>
                      </div>
                    )}
                    {t.claims && t.claims.unsupported.length > 0 && (
                      <div className="mark soft">
                        <strong>
                          {t.claims.unsupported.length} of {t.claims.checked} statements are not
                          supported by the books
                        </strong>
                        <ul>
                          {t.claims.unsupported.map((u, j) => (
                            <li key={j}>
                              <q>{u.claim}</q>
                              {u.missing ? <> Searched again and found nothing on: {u.missing}.</> : null}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {t.claims && t.claims.inferences.length > 0 && (
                      <div className="note aside">
                        <strong>The assistant&rsquo;s conclusion, not the book&rsquo;s words</strong>
                        <p>
                          {t.claims.inferences.length === 1
                            ? 'This is a reading of the passages rather than something one of them states. '
                            : 'These are readings of the passages rather than things they state. '}
                          Reasonable, but check {t.claims.inferences.length === 1 ? 'it' : 'them'}{' '}
                          against the text before relying on {t.claims.inferences.length === 1 ? 'it' : 'them'}.
                        </p>
                        <ul>
                          {t.claims.inferences.map((u, j) => <li key={j}><q>{u.claim}</q></li>)}
                        </ul>
                      </div>
                    )}
                    {/* Asked once, under the third answer, where the reader has
                        just finished reading the thing being rated. */}
                    {i === lastRated && <Rate key={i} turn={t} />}
                    {t.claims && t.claims.recovered.length > 0 && (
                      <div className="note aside">
                        <strong>
                          Found on a second search: {t.claims.recovered.length}{' '}
                          {t.claims.recovered.length === 1 ? 'statement' : 'statements'}
                        </strong>
                        <p>
                          Supported by {t.claims.extraCitations.length}{' '}
                          {t.claims.extraCitations.length === 1 ? 'passage' : 'passages'} the first
                          search missed: {t.claims.extraCitations
                            .map((c) => `${c.bookTitle} ${chapterRef(c.chapterTitle)}`).join(', ')}.
                        </p>
                      </div>
                    )}
                    <Provenance turn={t} />
                    <Trace trace={t.trace} />
                  </div>
                )}
            </div>
          ))}

          {busy && (
            <div className="card card-pad steps">
              {live.map((l, i) => (
                <div className="step" key={i} data-live={i === live.length - 1}>
                  <span className="dot" />{l}
                </div>
              ))}
            </div>
          )}
          {err && <p className="err">{err}</p>}
          <div ref={end} />

          <div className="composer">
            <div className="card card-pad">
              <div className="composer-shell">
                {/* Sources sit inside the box you type into, so what the question
                    can reach is visible at the moment of asking. */}
                {/* Which books a question can reach is chosen in the books
                    column, while looking at the shelf. The shape of the answer
                    is chosen by the question itself (D-78). */}
                {/* The placeholder is short enough to survive a 390px composer.
                    The longer invitation lives in the empty state, where there
                    is room for it. */}
                <div className="row">
                  <input type="text" value={input}
                         placeholder="Ask, compare, or find a passage…"
                         onChange={(e) => setInput(e.target.value)}
                         onKeyDown={(e) => e.key === 'Enter' && send()} />
                  <button className="go" onClick={send} disabled={busy || !input.trim()}>Ask</button>
                </div>
              </div>
            </div>
          </div>
    </div>
  );
}

/* ─────────────────────────────── App ─────────────────────────────── */

/* ─────────────────────────── the shell ─────────────────────────── */

const STORE_KEY = 'editorial.threads.v1';
const newThread = (): Thread =>
  ({ id: `t${Date.now()}`, title: 'New thread', at: Date.now(), turns: [], scope: [] });

/**
 * Saved conversations, left column.
 *
 * localStorage, not a server, and the interface says so rather than implying a
 * backend that does not exist. The README sets out what server-side threads
 * would actually take.
 */
function Threads({ threads, activeId, onOpen, onNew, onDelete }: {
  threads: Thread[]; activeId: string;
  onOpen: (id: string) => void; onNew: () => void; onDelete: (id: string) => void;
}) {
  return (
    <>
      <button className="new-thread" onClick={onNew}>+ New thread</button>
      <div className="thread-list">
        {threads.length === 0 && <p className="hint thread-empty">Conversations are kept on this device.</p>}
        {threads.map((t) => (
          <div className="thread" key={t.id} data-active={t.id === activeId}>
            <button className="thread-open" onClick={() => onOpen(t.id)} title={t.title}>
              <span className="thread-title">{t.title}</span>
              <span className="thread-meta">
                {(() => {
                  const n = t.turns.filter((x) => x.role === 'assistant').length;
                  return `${n || 'no'} ${n === 1 ? 'answer' : 'answers'}`;
                })()}
              </span>
            </button>
            <button className="thread-del" onClick={() => onDelete(t.id)} aria-label="Delete thread">✕</button>
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * The books, right column: what a question can reach, and the way into reading.
 *
 * The Library used to be a separate destination. On one screen it becomes the
 * context panel for the conversation, which is what it always was in practice:
 * the reader looks something up, then asks about it.
 */
/**
 * The books, right column. This is where "what a question can reach" lives.
 *
 * The selection used to sit in the composer as chips. It belongs here: the
 * books ARE the context, and a reader deciding what to ask about is looking at
 * the shelf, not at the text box. Comparison only exists when two are in
 * context, so the choice between one joined answer and one per book (D-48)
 * appears here too, attached to the thing that makes it possible.
 *
 * Opening a book shows its chapters with their notes. Reading the text is one
 * more deliberate step from there (D-47).
 */
function BooksPanel({ books, scope, onScope, onOpenChapter, collapse }: {
  books: Book[];
  scope: string[];
  onScope: (ids: string[]) => void;
  onOpenChapter: (bookId: string, index: number) => void;
  /** Rises when a passage opens below. The chapter list folds so the passage
   *  is what the column is showing, rather than the third thing down it. */
  collapse?: unknown;
}) {
  const [open, setOpen] = useState<string>('');
  useEffect(() => { if (collapse) setOpen(''); }, [collapse]);
  const [chapters, setChapters] = useState<Record<string, { index: number; title: string; summary?: string }[]>>({});

  useEffect(() => {
    if (!open || chapters[open]) return;
    get(`/api/books/${open}/summary`)
      .then((r) => setChapters((c) => ({ ...c, [open]: r.chapters ?? [] })))
      .catch(() => get(`/api/books/${open}/chapters`).then((cs) => setChapters((c) => ({ ...c, [open]: cs }))));
  }, [open]);

  // Never empty: a question with nothing in view can reach nothing.
  const toggle = (id: string) =>
    onScope(scope.includes(id) ? (scope.length > 1 ? scope.filter((x) => x !== id) : scope) : [...scope, id]);

  return (
    <div className="books-panel">
      {books.map((b) => {
        const inScope = scope.includes(b.id);
        return (
          <div className="panel-book" key={b.id} data-open={open === b.id} data-scope={inScope}>
            <div className="pb-row">
              <label className="pb-check" title={inScope ? 'In context' : 'Not in context'}>
                <input type="checkbox" checked={inScope} onChange={() => toggle(b.id)} />
              </label>
              <button className="panel-book-head" onClick={() => setOpen(open === b.id ? '' : b.id)}>
                <span className="pb-title">{b.title}</span>
                <span className="pb-by">{b.author}</span>
                <span className="pb-facts">
                  {b.chapters} chapters
                  <span className="pb-caret" aria-hidden>{open === b.id ? '▴' : '▾'}</span>
                </span>
              </button>

            </div>
            {open === b.id && (
              <div className="panel-chapters">
                {(chapters[b.id] ?? []).map((c) => (
                  <details className="panel-chapter" key={c.index}>
                    <summary>
                      <span className="n">{chapterRef(c.title)}</span>
                      <span className="ct">
                        {stripRef(c.title) || firstClause(c.summary) || 'Chapter'}
                      </span>
                    </summary>
                    <div className="pc-body">
                      <p>{c.summary || 'No note for this chapter.'}</p>
                      <button className="open-here" onClick={() => onOpenChapter(b.id, c.index)}>
                        Read the full chapter
                      </button>
                    </div>
                  </details>
                ))}
                {!chapters[b.id] && <p className="hint" style={{ margin: '8px 4px' }}>Loading…</p>}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}

export default function App() {
  const [books, setBooks] = useState<Book[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [reading, setReading] = useState<any>(null);
  const [help, setHelp] = useState(false);
  const helpSheet = useRef<HTMLDivElement>(null);
  useEffect(() => { if (help) helpSheet.current?.focus(); }, [help]);
  useEffect(() => {
    if (!help) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelp(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [help]);
  /**
   * Narrow screens have one column, so the other two become panels you open.
   * Hiding them entirely, which is what the first breakpoint did, meant a phone
   * could not see which books a question would reach or switch conversation.
   */
  const [panel, setPanel] = useState<'' | 'threads' | 'books'>('');
  const [readerChapters, setReaderChapters] = useState<{ index: number; title: string }[]>([]);
  const [dark, setDark] = useState<boolean>(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false,
  );

  const [threads, setThreads] = useState<Thread[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
      return Array.isArray(saved) && saved.length ? saved : [newThread()];
    } catch { return [newThread()]; }
  });
  const [activeId, setActiveId] = useState(() => threads[0]?.id ?? '');
  const active = threads.find((t) => t.id === activeId) ?? threads[0];

  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, [dark]);
  // Books are behind the gate, so they are fetched once it is open rather than
  // on mount. Locally `locked` is never true and this runs immediately.
  const locked = health?.locked === true;
  useEffect(() => {
    if (health && !locked) get('/api/books').then(setBooks).catch(() => {});
  }, [health, locked]);
  useEffect(() => {
    get('/api/health').then(setHealth).catch(() => {});
  }, []);
  /**
   * Persist on every change, merged rather than overwritten.
   *
   * Each tab holds the whole thread list in its own state, so writing that list
   * wholesale meant the last tab to save erased conversations the other tab had
   * just had. Two tabs, one question each: the second tab's thread was gone from
   * storage, and a tab saving a snapshot taken before its answer arrived left the
   * thread behind reading "no answers".
   *
   * Merging by id and keeping whichever copy was touched last makes the write
   * safe from any number of tabs, and the storage event brings the other tab's
   * work into this one instead of silently discarding it.
   */
  useEffect(() => {
    try {
      const stored: Thread[] = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
      const merged = new Map(stored.map((t) => [t.id, t]));
      for (const t of threads) {
        const other = merged.get(t.id);
        // On the same id, keep the longer conversation rather than the later
        // write. Two tabs opened on the same thread cannot be truly reconciled
        // without turn-level history; keeping the fuller one at least never
        // trades a real exchange for an empty one.
        const keepOther = other && (other.turns.length > t.turns.length
          || (other.turns.length === t.turns.length && other.at > t.at));
        merged.set(t.id, keepOther ? other : t);
      }
      const all = [...merged.values()].sort((a, b) => b.at - a.at).slice(0, 40);
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch { /* quota, or another tab mid-write */ }
  }, [threads]);

  // Another tab saved. Take in anything this tab has never seen.
  useEffect(() => {
    const onStore = (e: StorageEvent) => {
      if (e.key !== STORE_KEY || !e.newValue) return;
      try {
        const incoming: Thread[] = JSON.parse(e.newValue);
        setThreads((ts) => {
          const mine = new Set(ts.map((t) => t.id));
          const fresh = incoming.filter((t) => !mine.has(t.id));
          return fresh.length ? [...ts, ...fresh].sort((a, b) => b.at - a.at) : ts;
        });
      } catch { /* ignore a partial write */ }
    };
    addEventListener('storage', onStore);
    return () => removeEventListener('storage', onStore);
  }, []);

  const patch = (p: Partial<Thread> | ((t: Thread) => Partial<Thread>)) =>
    setThreads((ts) => ts.map((t) => {
      if (t.id !== activeId) return t;
      const next = { ...t, ...(typeof p === 'function' ? p(t) : p), at: Date.now() };
      // The first question names the thread, which is what every chat tool does
      // and is better than asking the reader to title it.
      if (next.title === 'New thread') {
        const first = next.turns.find((x) => x.role === 'user')?.content;
        if (first) next.title = first.length > 46 ? `${first.slice(0, 46)}…` : first;
      }
      return next;
    }));

  const openChapter = async (bookId: string, index: number) => {
    setReading(await get(`/api/books/${bookId}/chapters/${index}`));
    get(`/api/books/${bookId}/summary`)
      .then((r) => setReaderChapters(r.chapters ?? []))
      .catch(() => setReaderChapters([]));
  };

  const shown = active?.turns.flatMap((t) => t.citations ?? []).find((c) => c.id === pinned);
  // The spans the answer quoted out of this passage, so the panel can mark the
  // same words the chat marks. Without it the reader still has to find the
  // sentence inside 350 words of prose, which is the work the citation was
  // supposed to remove.
  // A passage is up to 350 words and the sentence the answer used is rarely the
  // first one. Opening at the top means the reader still has to hunt, which is
  // the work the citation exists to remove, so the marked line is brought into
  // view. `block: 'center'` rather than 'start' because a quotation reads better
  // with the sentences around it.
  const passageBody = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const mark = passageBody.current?.querySelector('mark.echo');
    if (mark) mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [pinned]);

  const quotedHere = (() => {
    if (!shown) return [] as string[];
    const turn = active?.turns.find((t) => (t.citations ?? []).some((c) => c.id === pinned));
    if (!turn) return [];
    const flat = (x: string) =>
      x.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/\s+/g, ' ');
    const hay = flat(shown.text);
    return [...turn.content.matchAll(/\u201C([^\u201D]{12,})\u201D/g)]
      .map((m) => m[1].trim())
      .filter((q) => hay.includes(flat(q)))
      .filter((q, i, a) => a.indexOf(q) === i);
  })();
  const readingBook = books.find((b) => b.id === reading?.bookId);

  // Nothing else mounts until the gate is open, so no request can 401 behind the
  // reader's back and no empty interface flashes before the password screen.
  if (locked) return <Unlock onOpen={() => get('/api/health').then(setHealth).catch(() => {})} />;

  return (
    <div className="app" data-panel={panel}>
      {/* Only rendered narrow. The two side columns collapse into these. */}
      <div className="mobile-bar">
        <button className="mb-btn" data-on={panel === 'threads'}
                onClick={() => setPanel(panel === 'threads' ? '' : 'threads')}>
          Conversations
        </button>
        <div className="brand-mark">E</div>
        <button className="mb-btn" data-on={panel === 'books'}
                onClick={() => setPanel(panel === 'books' ? '' : 'books')}>
          {(active?.scope ?? []).length === 1 ? '1 book' : `${(active?.scope ?? []).length} books`}
        </button>
      </div>

      <aside className="col-threads">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div className="brand-name">Editorial</div>
        </div>

        <Threads
          threads={threads} activeId={activeId}
          onOpen={(id) => { setActiveId(id); setPinned(null); setPanel(''); }}
          onNew={() => { const t = newThread(); setThreads((ts) => [t, ...ts]); setActiveId(t.id); setPinned(null); setPanel(''); }}
          onDelete={(id) => setThreads((ts) => {
            const left = ts.filter((t) => t.id !== id);
            const next = left.length ? left : [newThread()];
            if (id === activeId) setActiveId(next[0].id);
            return next;
          })}
        />

        <div className="col-foot">
          <button className="foot-btn" onClick={() => setHelp(true)}>
            <span className="fi">?</span> How it works
          </button>
          <button className="foot-btn" onClick={() => setDark((d) => !d)}
                  title={dark ? 'Switch to light' : 'Switch to dark'}>
            <span className="fi">{dark ? '☾' : '☀'}</span> {dark ? 'Dark' : 'Light'}
          </button>
          {!health && <div className="col-stat">connecting…</div>}
        </div>
      </aside>

      <main className="col-chat">
        {/* Keyed by thread. The draft and the error live in Ask, so without this
            a half-typed question and a failed request followed you into the next
            conversation. */}
        {active && (
          <Ask key={active.id} books={books} thread={active}
               onThread={patch} onPick={setPinned} pinned={pinned}
               onHelp={() => setHelp(true)} />
        )}
      </main>

      <aside className="col-books">
        <div className="col-head"><span>In context</span></div>

        <BooksPanel
          books={books}
          scope={active?.scope ?? []}
          onScope={(ids) => patch({ scope: ids })}
          onOpenChapter={(b, i) => { setPanel(''); openChapter(b, i); }}
          collapse={pinned}
        />

        {shown && (
          <div className="passage" key={shown.id}>
            <div className="passage-head">
              <div className="passage-where">
                <span className="passage-book">{shown.bookTitle}</span>
                <span className="passage-chapter">{tidyTitle(shown.chapterTitle)}</span>
              </div>
              <button className="passage-close" aria-label="Close passage"
                      onClick={() => setPinned(null)}>✕</button>
            </div>
            <div className="passage-body" ref={passageBody}>
              {/* Only the words the answer quoted are marked. Marking the
                  reader's query words as well put a second, weaker highlight
                  next to the first, and on this corpus it lit up "books" and
                  "chapter" in every passage, which is noise wearing the costume
                  of a match. */}
              <Highlight text={shown.text} spans={quotedHere} spanClass="echo" />
            </div>
            <button className="passage-go"
                    onClick={() => openChapter(shown.bookId, shown.chapterIndex)}>
              Read the whole chapter
            </button>
          </div>
        )}


      </aside>

      {/* A page, not a modal. It is read, not acknowledged, and a dialog you have
          to dismiss to try the thing it describes is the wrong shape. */}
      {help && (
        <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="help-title"
             tabIndex={-1} ref={helpSheet}>
          <div className="sheet-bar">
            <span className="meta">How it works</span>
            <span className="grow" />
            <button className="shut" onClick={() => setHelp(false)}>Close</button>
          </div>

          <div className="sheet-scroll">
            <div className="sheet-body">
              <h3 id="help-title">How it works</h3>
              <p className="lede">
                Ask in plain words. Every answer is built from passages in the books on the right,
                and each claim is marked with where it came from, so nothing has to be taken on
                trust.
              </p>

              <div className="help-grid">
                <section>
                  <h4>Ask, then check</h4>
                  <p>
                    A marker like <span className="cite-demo">PP XIX</span> after a sentence is the
                    source of that sentence. Select it and the passage opens on the right, with the
                    words used in the answer marked in both places. From there,{' '}
                    <b>Read the whole chapter</b> opens the full text.
                  </p>
                </section>

                <section>
                  <h4>Choosing what a question can reach</h4>
                  <p>
                    Each book on the right has a tick. Ticked means a question may use it. Untick one
                    to ask about the other on its own, which is the quickest way to stop an answer
                    wandering into the wrong book.
                  </p>
                </section>

                <section>
                  <h4>Reading without asking</h4>
                  <p>
                    Select a book&rsquo;s name on the right to open its chapters. Every chapter has a
                    summary of what happens in it, so you can find the part you want before asking
                    anything, and <b>Read the full chapter</b> opens the text itself.
                  </p>
                </section>

                <section>
                  <h4>You never pick a mode</h4>
                  <p>
                    Ask for a comparison and you get one answer drawing the books together. Ask what
                    each says and you get one answer per book. The wording of the question decides.
                  </p>
                </section>
              </div>

              <h4>What you can ask, and what it costs</h4>
              <p>
                Prices are estimates. The model provider does not publish rates for this deployment,
                so they are there to show which questions are cheap and which are not.
              </p>
              <div className="scrolls">
                <table className="costs">
                  <tbody>
                    <tr>
                      <td><em>What is Little Women about?</em></td>
                      <td>reads the prepared notes</td>
                      <td className="c">$0.012</td>
                    </tr>
                    <tr>
                      <td><em>Why does Elizabeth refuse Mr Collins?</em></td>
                      <td>searches, then answers from passages</td>
                      <td className="c">$0.021</td>
                    </tr>
                    <tr>
                      <td><em>Find passages about money and inheritance</em></td>
                      <td>searches several phrasings at once</td>
                      <td className="c">$0.021</td>
                    </tr>
                    <tr>
                      <td><em>How many times is Longbourn mentioned?</em></td>
                      <td>counts the text, no model involved</td>
                      <td className="c">free</td>
                    </tr>
                    <tr>
                      <td><em>How many chapters have a confrontation?</em></td>
                      <td>reads every chapter summary and judges each</td>
                      <td className="c">$0.020</td>
                    </tr>
                    <tr>
                      <td><em>Do these books share copied wording?</em></td>
                      <td>compares both books passage by passage</td>
                      <td className="c">$0.051</td>
                    </tr>
                    <tr>
                      <td><em>How many chapters does each have?</em></td>
                      <td>reads the collection, no search</td>
                      <td className="c">$0.002</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h4>What the notes under an answer mean</h4>
              <ul className="plain">
                <li>
                  <b>A source does not exist.</b> The answer pointed at something that is not in
                  either book. Do not rely on that sentence.
                </li>
                <li>
                  <b>Not supported by the books.</b> A statement no passage backs, checked twice.
                  Worth verifying before you use it.
                </li>
                <li>
                  <b>The assistant&rsquo;s conclusion.</b> A reading of the passages rather than
                  something they say. Reasonable, and still a judgement.
                </li>
                <li>
                  <b>How this answer was produced.</b> What it searched for and how many passages the
                  answer rests on. Open <b>Timings and cost</b> underneath for the detail.
                </li>
              </ul>

              <h4>Your conversations</h4>
              <p>
                Threads on the left stay in this browser. Nothing is sent anywhere and nothing is
                shared. Starting a new thread gives you a clean context.
              </p>
            </div>
          </div>
        </div>
      )}

      {reading && (
        <Reader book={readingBook} chapter={reading} chapters={readerChapters}
                onClose={() => setReading(null)} onMove={(i) => openChapter(reading.bookId, i)} />
      )}
    </div>
  );
}
