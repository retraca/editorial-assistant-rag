# How it works

What happens between a question arriving and an answer appearing, and why each step is there.

The reasoning behind individual choices is in [DECISIONS.md](../DECISIONS.md); the measurement
instruments are in [EVALUATION.md](./EVALUATION.md). This is the map.

---

## The shape of it

```
                    ONCE, AT BUILD TIME
  data/books/*.html
      |  parse.ts      h2 boundaries, drop caps recovered from img alt
      v
  chapters (47 + 61)   apparatus dropped: preface, ads, transcriber notes
      |  chunk.ts      350 words, 60 overlap, never crossing a chapter
      v
  1,330 chunks --> embed (1,024 dims) --> data/index/  5.2 MB
      |
      +--> summarise.ts --> data/summaries.json   chapter and book notes,
                                                  quotations verified verbatim

                    PER QUESTION
  question
      |
      v
  [ agent loop, max 5 steps ]-----> seven tools
      |                              search_books      hybrid + rerank + expand
      |                              about_the_book    whole-book notes
      |                              about_the_collection
      |                              list_chapters / read_chapter
      |                              compare_books     similarity + verbatim reuse
      v
  answer + cited passages
      |
      +--> verify.ts    do the cited ids resolve, were they retrieved   (free)
      +--> quotes.ts    is every quoted span real                       (free)
      +--> claims.ts    does each sentence follow from the evidence     (1 call)
      v
  answer + citations + three verdicts
```

---

## Build time

**Parsing** splits on `<h2>`, the one structural signal both books share, because they format chapter
titles differently and a per-book regex is a per-book maintenance problem (D-02). Two Gutenberg
quirks are handled: drop caps live in `<img alt="N">` and decapitate a chapter if images are stripped
first, and some headings arrive as `CHAPTERXXVIII` (D-39).

**Only the work itself is indexed.** Pride and Prejudice ships with George Saintsbury's 1894 critical
introduction, and Little Women with a publisher's catalogue and a page of transcriber's notes: 28
chunks that read as the books and are not them. The introduction is the dangerous one, because
criticism is written in the register a thematic question is phrased in, so it took the top two ranks
for *"what is distinctive about the humour in this book"* and seven of ten results. All three output
guardrails passed it, correctly, because it genuinely was in the corpus. A guardrail cannot tell you
the corpus is wrong. Sections are dropped after indices are assigned, so no chunk id moves (D-84).

**Chunking** targets 350 words, never crosses a chapter, and never splits a paragraph unless it has
to, so every passage can be cited as *Book, Chapter*. Paragraphs over the target split on sentence
boundaries, because Gutenberg renders Darcy's letter as a single 2,480-word `<p>` (D-04). Overlap is
60 words and is **known to be the wrong instrument for the job it was chosen for**: it heals 11 of 30
boundary seams while fetching the neighbouring chunk at query time heals 30 of 30 (D-68). It still
ships because flipping it invalidates 120 chunk-id-based eval cases, which is the top open item.

**Embedding** uses 1,024 of the model's 3,072 dimensions, a Matryoshka truncation that costs a third
of the storage (D-15). The whole index is 5.2 MB and lives in memory: 1,330 chunks scanned by brute
force takes 4 to 6 ms, against a ~300 ms round trip to the model, so a vector database would optimise
the fastest part of the request (D-05).

**Summarising** is a separate pass that reads every chapter and writes a note plus its key moments.
The moments are quotations, and each is checked character by character against the chapter before it
is stored, because a note that misquotes is worse than no note. It costs $1.08 and 11 minutes, and the
output ships in the repo (D-43).

---

## Retrieval

Two arms, fused.

**Dense** is cosine over the embedding. **Sparse** is BM25, ~110 lines, no dependency (D-06). They are
combined with Reciprocal Rank Fusion rather than by normalising scores, because the two scales are
not comparable and any normalisation invents a conversion rate between them (D-07).

Hybrid is kept for **failure-mode coverage, not average superiority**, and the distinction matters
because the averages say they are indistinguishable. Searching `Mrs Younge` misses entirely at k=8
under dense retrieval while BM25 ranks it first: editors search for names, and that is exactly where
embeddings smear a rare token toward its neighbourhood (D-24).

Three things sit on top:

- **Alias expansion** into the lexical arm only, at weight 0.3. BM25 treats "Lizzy" and "Elizabeth"
  as unrelated tokens. `beth -> elizabeth` is deliberately absent, because "elizabeth" appears in 411
  Pride and Prejudice chunks and 2 of Little Women's (D-25).
- **Reranking**, an LLM pass over 24 over-fetched candidates cut back to 8. Worth +8.3pp chapter
  recall, and it costs ~28% of an answer (D-20).
- **Entity expansion**, a follow-up search for rare names found in results but absent from the query
  (D-31).
- **Neighbour expansion**, which appends the chunks either side of the two strongest hits. This is
  what actually solves boundary-spanning answers: chunk overlap heals 11 of 30 test seams, fetching
  the neighbour heals 30 of 30 (D-68).

`search_books` is the only tool that goes through all of this. `about_the_book` reads the notes,
`about_the_collection` reads counts, and neither searches, because three kinds of question need three
different moves and conflating them produced real failures (D-42, D-57).

---

## The agent loop

A bounded tool-calling loop, five steps maximum. On the last step the tools are withheld so the model
must answer from what it has, rather than looping forever against a paid API (D-13). Tool calls
issued in the same step run concurrently, which halves a two-search turn (D-30).

**Book scope is enforced in the tool layer, not requested in the prompt.** With one book selected the
other cannot be reached, whatever the model decides to call. The selection is also stated in the
prompt so the assistant's answers do not promise what its retrieval cannot deliver (D-45).

The model chooses the tools. There is no hand-written router, because "compare how the two books
treat marriage" and "what does Jo say about writing" need different retrieval shapes and choosing
between them is exactly what the model is good at (D-12).

---

## After the answer: three checks

None of them rewrites anything. An editor deciding whether to trust an answer needs to see which
sentence to distrust, not a smoother paragraph.

| check | question | how | cost |
|---|---|---|---|
| **citations** | does every cited id resolve, and was it retrieved this turn | index lookup | free |
| **quotations** | does every quoted span of six words or more appear in the books | string comparison | free |
| **claims** | does each sentence follow from the evidence gathered | model judgement | ~35% of the answer |

The claim check reports **three** outcomes, because they ask different things of a reader:

- **unsupported** survived a second, targeted search. A genuine addition.
- **recovered** was supported by a passage the first search missed. A retrieval failure, not a
  fabrication, and the passage is attached so the reader can open it (D-62).
- **inference** is the assistant's own judgement, which no passage can settle either way. Marked,
  not warned about (D-63).

The distinction between the first two exists because a flag conflated them for most of this project's
life, and they want opposite fixes. The distinction between the first and the third exists because
the interface was putting alarm colours under an opinion the reader had asked for.

**The evidence set is the whole corpus, not the retrieved passages.** Whether a quotation is real is a
question about the books; whether it came from this question's evidence is a separate one. Getting
that wrong three times in different places is written up as D-66.

---

## Observability

Every request produces a trace: per-stage timings, token counts split by cached and uncached, and an
estimated cost. It is logged as one JSON line and shown in the interface, so an editor can see that
an answer took two searches and cost $0.02.

The prices are **assumptions**, and are labelled as such wherever they appear. The sandbox does not
publish rates for this deployment, so the figures make cost visible and relative rather than
billing-accurate (D-11).

Typical costs, measured:

| question | cost | time |
|---|---|---|
| refusal, no search | $0.0009 | 2.0s |
| collection facts | $0.0019 | 2.9s |
| whole book, from notes | $0.0125 | 5.8s |
| ordinary lookup | $0.0214 | 11.6s |
| comparison | $0.0512 | 29.8s |

---

## The interface

**One screen, three columns.** Conversations on the left, the assistant in the middle, the books on
the right. Nothing navigates anywhere: the books column is the context control, ticking a book
decides what a question can reach, and the chapters and the reader open in place beneath it.

It arrived there by removing things. Search was a tab, then a panel inside the Library, and is now
folded into the one composer, because a question and a search are the same act to an editor (D-47,
D-77). Comparison was a tab, then a checkbox, and is now inferred from how the question is phrased,
because asking someone to classify their own question before asking it is asking them to do the
system's work (D-48, D-78). The Library was a destination and stopped being one (D-76).

Two rules run through all of it: never show a number the reader cannot act on, and never show
internal vocabulary. Both are enforced in code at the boundary, and both are tested (D-33, D-35).

---

## What runs where

```
backend    Fastify, TypeScript, tsx. Port 8080. Holds the index in memory.
frontend   Vite, React, no component library. Port 5173, proxies /api.
docker     two services, backend healthchecked on 127.0.0.1 before frontend starts
```

The index is a build artefact and is mounted rather than baked in, so `npm run ingest` survives a
rebuild. `data/summaries.json` **is** baked in, because it is committed rather than generated at
deploy, and leaving it out silently 404'd every summary inside the container while everything worked
outside it.
