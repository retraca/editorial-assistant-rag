# Editorial Assistant

A tool for a book publishing company's editorial team: explore the books, ask grounded questions about
them, and find passages that resemble each other across authors.

**Who it is for, specifically.** Editorial is a relay: acquisition, development, line editing,
copyediting, proofreading. This tool serves two desks in it. The **acquiring editor** who needs to get
inside an unfamiliar manuscript quickly, and the **rights or legal desk** asking whether a submission
sits too close to something already published. It is not a copyediting tool: it does not track
continuity, build a style sheet, or catch an author's repeated tics. Naming that is the difference
between a tool that is aimed and one that is merely assembled.

Built against *Little Women* (Alcott) and *Pride and Prejudice* (Austen), 307,689 words of novel.
Gutenberg's apparatus, a critical introduction, a publisher's catalogue and transcriber's notes, is
parsed out rather than indexed: it reads like the books and is not them (D-84).

## Quick start

```bash
cp .env.example .env          # add AZURE_OPENAI_API_KEY
docker compose up --build     # API on :8080, interface on :5173
```

Then open **http://localhost:5173** and ask a question. The built index ships in `data/index/`, so
there is nothing to prepare and no embedding cost before the first one. Without Docker, or to run
the tests and the eval, see [Setup](#setup) below.

---

Setup, approach, and the key technical decisions, assumptions and trade-offs are all here, in the
sections below. The other documents are depth, not the summary:

- **[DECISIONS.md](./DECISIONS.md)** is the long form: 102 entries stating what was chosen, what was
  rejected, why, and what evidence would change it. It opens with an index by theme.
- **[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)** traces a question from arrival to answer: the
  ingest pipeline, the two retrieval arms and what sits on top of them, the agent loop, and the three
  checks that run afterwards.
- **[docs/EVALUATION.md](./docs/EVALUATION.md)** covers the eight measurement instruments: what each
  one answers, what it cannot see, and how to add a case.

---

## Where things are

| what to look at | where |
|---|---|
| how the problem is structured | the four use cases below; D-57 on grouping the eval by job rather than mechanism |
| orchestrating LLMs and data sources | [ARCHITECTURE](./docs/ARCHITECTURE.md): two retrieval arms fused, a reranker, a bounded tool loop, nine tools |
| managing context and reasoning | book scope enforced in the tool layer (D-45), `k` chosen on measured context precision (D-88), three post-generation checks |
| pragmatic technical decisions | [DECISIONS.md](./DECISIONS.md), and the Assumptions and Known limits sections here |

The eval reports by use case, and there are four:

| | | cases |
|---|---|---|
| G1 | exploring and understanding book content | 5 |
| G2 | answering questions about specific parts of a book | 9 |
| G3 | identifying relevant passages | 28 |
| G4 | comparing content across books | 6 |
| guard | refusing what is out of scope | 4 |

Scoring by mechanism alone hid a gap: G1 had no cases, and its first one scored 0/3 on groundedness
every run because eight retrieved passages cannot describe a novel. That is D-57.

## Setup

### Prerequisites
Docker, or Node 20+. Azure OpenAI credentials for a chat and an embedding deployment.

### 1. Configure

```bash
cp .env.example .env
# fill in AZURE_OPENAI_API_KEY (and endpoint/deployments if they differ)
```

`.env` is gitignored and must never be committed.

### 2. Run with Docker

```bash
docker compose up --build
```

**The built index is committed**, in `data/index/`, so there is nothing to build and no embedding
cost before the first question. To rebuild it from scratch:

```bash
docker compose exec backend npx tsx src/ingest/build-index.ts   # only if data/index is empty
```

If `docker compose` reports `unknown command`, the Compose plugin is not installed; use the
standalone binary `docker-compose` instead. This project was verified with the standalone binary
(Compose v5.1.4) against Docker 29.5.2.

### 3. Or run locally

```bash
cd backend  && npm install && npm run dev   # :8080   (add `npm run ingest` only if data/index is empty)
cd frontend && npm install && npm run dev   # :5173
```

```bash
cd backend && npm run summarise    # ~11 min, ~$1.08 (output is committed)
```

`npm run summarise` reads every chapter and writes its summary and key moments to
`data/summaries.json`. The output ships with the repo, so this only needs re-running if the corpus
changes. Summaries are generated **from the indexed text**, never recalled by the model, see D-43
for why that distinction decides whether the feature works on a real manuscript.

`npm run ingest` parses, chunks and embeds both books. It takes **~130 seconds** and costs about
**$0.07** in embedding tokens. Run it only to build the index the first time, or to rebuild after
changing the corpus or the chunking.

Open **http://localhost:5173**.

### Verify

```bash
curl localhost:8080/api/health
# {"ok":true,"chunks":1330,"dims":1024,...}

cd backend && npm test                          # 77 unit tests, offline, no API key
cd backend && npm run eval                      # 52 cases, reported by use case
cd backend && npm run eval -- --retrieval-only  # fast loop, no LLM calls
cd backend && npm run eval -- --only=g4         # one group, while iterating

# Harder, generated set, 60 paraphrased questions with known gold passages
cd backend && npm run eval:generate             # ~35s, ~$0.04 (already committed)
cd backend && npm run eval:hard -- --mode=hybrid [--rerank] [--k=4]

# Needle-in-a-haystack, plants synthetic passages, measures find/use/cite
cd backend && npm run eval:niah [-- --no-answer] [--mode=sparse] [--no-rerank]

# Paired significance test between two saved runs
cd backend && npm run eval:compare -- a.json b.json

# Context precision across k, and answer relevance against a baseline
cd backend && npm run eval:quality [-- --k=4,8,12] [--sample=30] [--only=context|relevance]
```

---

## Approach

**Ingest.** Gutenberg HTML is segmented at `<h2>` boundaries. The one structural signal both books
share, since they format chapter titles differently. Chunks target 350 words, never cross a chapter,
and never split a paragraph, so every retrieved passage can be cited as *Book, Chapter*. Paragraphs
longer than the target are split on sentence boundaries: Gutenberg renders Darcy's letter (P&P
ch. XXXV) as a single 2,480-word `<p>`, which would otherwise become one useless 7x-oversized chunk.

**Retrieval.** Hybrid, dense embeddings and BM25, fused with Reciprocal Rank Fusion. Everything is
in memory: 1,330 chunks × 1,024 dims is 5.2 MB and a full scan takes 4–6 ms, so there is no vector
database. The network round-trip to Azure is ~300 ms, two orders of magnitude larger than search.

**Books in view.** The reader chooses which books a question may use, and that selection is enforced
in retrieval rather than suggested to the model, with one book selected the other cannot be reached.
With two in view, whether the answer draws them together or treats them separately is **inferred
from how the question is phrased**, not chosen from a control. "Compare the proposal scenes" and
"answer separately for each book" want different shapes and both say so in words. Comparison was a
tab, then a checkbox, and is now neither, because asking a reader to classify their own question
before asking it is asking them to do the system's work (D-48, reversed in D-78).

**Feedback.** Every answer can be rated. A negative rating asks one follow-up
(*was it the passages, or the answer?*) because that maps onto the two things the eval measures separately, and each one is
written out as a candidate test case in the harness's own format. A complaint from real use becomes a
regression test.

**Assistant.** A bounded tool-calling loop with nine tools. The model chooses; there is no
hand-written router. Three of them exist because three *kinds* of question need different moves, and
conflating them is a category error that produced real failures:

| question | tool | why not search |
|---|---|---|
| what a whole book is about | `about_the_book` | eight passages cannot describe a novel. This scored 0/3 on groundedness until the tool existed (D-57) |
| how many books, how long, how many chapters | `about_the_collection` | searching the prose for passages that mention numbers is a category error (D-42) |
| what happens at some point | `search_books` | the ordinary case |
| a subject the books may not name | `find_by_subject` | one query matches one register: *crime* alone returns only Little Women (D-53) |
| how often a word appears | `count_mentions` | a frequency is arithmetic. Asking a model to estimate it from eight passages is asking it to guess (D-94) |
| how many chapters contain something judged | `survey_chapters` | search returns the most relevant few, so it can find but never enumerate. This reads every chapter note and reports the definition it counted by (D-98) |

Plus `list_chapters`, `read_chapter` and `compare_books`. The assistant answers only from retrieved
passages, cites each claim by passage id, and declines anything outside the collection.

**Comparison. Two independent signals.** For cross-book similarity the shape is chunk→chunk rather
than query→chunk. Raw scores are not shown alone: two random passages from these books already score
**0.4316**, because both are 19th-century domestic novels. Every response carries that baseline,
results are diversified so one chapter cannot fill the list, and an LLM classifies each pair.

Running alongside it is a **verbatim reuse check**, 8-word shingles, hashed and inverted-indexed. 
which answers a different question. Embeddings ask *"do these mean similar things?"*; fingerprints ask
*"do these share actual wording?"* Only the second is evidence of derivation. On this corpus the
answer is decisive: Mr Collins' rejected proposal and Jo refusing Laurie score 0.6487 and classify as
`parallel_scene · high`, while sharing **zero** 8-word sequences across 153,931 indexed phrases. The
parallel is structural, not copied. A distinction an embeddings-only tool cannot make.

**Verification.** Three checks run after generation, in code rather than as prompt instructions, and
none of them rewrites the answer. An editor deciding whether to trust it needs to see which sentence
to distrust, not a smoother paragraph.

| check | question | how |
|---|---|---|
| citations (D-18) | does every cited id resolve, and was it retrieved this turn | index lookup |
| quotations (D-64) | does every quoted span appear in the books | string comparison |
| claims (D-61) | does each sentence follow from the evidence | model judgement |

The claim check reports three outcomes rather than one, because they want different responses from a
reader. **Unsupported** survived a second, targeted search and is a genuine addition. **Recovered**
was supported by a passage the first search missed, which is a retrieval failure rather than a
fabrication (D-62). **Inference** is the assistant's own judgement, marked rather than warned about,
since no passage can settle whether one novel is better written than another (D-63).

Recall on planted defects is 96%, with dropped negations, altered quotations and fabricated
sentences all caught at 100% (D-65, re-measured in D-83). The three checks add about **$0.007 and no measurable latency**
to a **$0.023, 17-second** answer. `CLAIM_CHECK=false` turns the model-judged one off; the other two
are free.

**Observability.** Every request produces a trace: per-stage timings, token counts, estimated cost.
It is logged as one JSON line and shown in the UI, so an editor can see that an answer took two
searches and cost $0.012.

---

## Using it

**One screen, three columns.** Saved conversations on the left, the conversation in the middle, the
books on the right.

**The books on the right are the context.** Both are in context by default; untick one to ask about
the other alone. Comparison only exists when two are in context, so the choice between one joined
answer and one per book (D-48) sits there too, attached to the thing that makes it possible. Open a
book for its chapters and their notes; open a chapter to read it.

**The conversation is a single input.** Ask a question, ask for a comparison, or ask for passages on a
subject: the routing happens in the backend, on what the question needs (D-77).

There are no mode buttons, and that is deliberate. The system already routes: a refusal costs $0.0009
and a comparison $0.05, chosen by which tools the question needs. Asking the reader to pick a mode
would be asking for a decision they have no basis to make, which is the same rule as never showing a
number they cannot act on. What the system *did* is shown after the fact, in words, under each answer.

**Adding a book is not in the interface.** Two books ship with the repository, and accepting a third
means parsing an arbitrary format rather than the Gutenberg HTML these share, an upload path, a
background job, and a cost the reader did not agree to. Indexing one takes about two minutes and
seven cents: the text is split into passages, each is embedded, and every chapter is read once to
write its notes. `npm run ingest` does it from the command line, where the person paying for it is
the person running it.

**Threads** on the left are kept in this browser's localStorage and titled from their first question.
Nothing is sent anywhere, because there is nowhere to send it: the sign-in button marks where identity
would go and says so when pressed. What making it real would require is in Known limits.

### API

| | |
|---|---|
| `GET /api/health` | index status |
| `GET /api/books` | collection, with chapter and chunk counts |
| `GET /api/books/:id/chapters` | chapter list |
| `GET /api/books/:id/summary` | the book's note, and a note per chapter |
| `GET /api/books/:id/chapters/:index` | one chapter's full text, note and key lines |
| `POST /api/chat` | `{messages, books?}` → answer, citations, steps, trace |
| `POST /api/chat/stream` | the same, as newline-delimited JSON with progress events |
| `POST /api/search` | `{query, book?, k?}` → passages with per-arm ranks |
| `POST /api/search/broaden` | `{query}` → one subject expanded across registers (D-53) |
| `POST /api/compare` | `{book_a, book_b, theme?, top_n?}` → pairs, baseline, verdicts |
| `POST /api/feedback` | a rating, and the case it would become |
| `GET /api/feedback/summary` | ratings so far, grouped by fault |
| `GET /api/traces` | last 50 request traces |

The interface uses six of these. `search`, `search/broaden`, `compare`,
`feedback/summary` and `traces` are the same capabilities without it: the
assistant is not the only way in.

---

## What was measured

**Current state: 47 to 49 of 52, quoted as a range on purpose.** Three runs of identical code scored
49, 49, 47. The deterministic half does not move: retrieval 24/24 with MRR 0.9479, G3 28/28, topic
2/2, refusal 4/4, every run. The variance is entirely in the LLM-judged answer cases, 17 to 19 of 22,
which is a property of the instrument and is why D-55 could not resolve `k` on answer quality and
D-88 had to. Plus 77 unit tests, all passing, offline.

The score is steadier than the cases behind it. Two runs both landed on 49 and disagreed about which
three cases failed, sharing only one. G4, comparison across books, is the loosest: 2/6, 4/6, 4/6
across the three runs, on six cases whose answers are long and interpretive, which is where a
groundedness judge has most room to differ with itself. Reading the total alone would hide that.

The score dropped from 45/46 when misquotation was made a failing condition: the suite had not been
checking it, and three answers carrying quotations verified absent from both books were passing. The
lower number is against a stricter test.

**The failures are real and left in.** `g4-proposals` ("compare the proposal scenes in both
books") fails groundedness intermittently (3/3 on one run, 0/3 on the next) because the answer generalises
past its passages: *"Austen's overall treatment of proposals"* is not supported by six retrieved
extracts. Comparison questions are the hardest grounding case precisely because they invite that
move. It is the known over-framing limit below, now with a test that catches it rather than a note
recording it.

**Retrieval (deterministic, identical across every run), 24 hand-written cases:**

| mode | MRR |
|---|---|
| **hybrid** | **0.9479** |
| sparse only | 0.9125 |
| dense only | 0.8917 |

**On aggregate, hybrid and dense are not distinguishable.** A paired bootstrap over the held-out set
spans zero on every metric. The earlier claim that hybrid retrieves better rested on two cases out of
sixty, recorded here because it was written down before it was tested properly (D-24).

**Hybrid is kept for failure-mode coverage, not average superiority.** There is a specific,
reproducible query class where dense fails hard: searching "Mrs Younge" **misses entirely at k=8**
under dense retrieval while BM25 ranks it first. Editors search for names, and that is exactly where
embeddings smear a rare token toward its neighbourhood. What *is* statistically solid is that both
dense and hybrid massively beat sparse alone.

**Character aliases.** BM25 treats "Lizzy" and "Elizabeth" as unrelated tokens (0/5 top-5 overlap),
and fusion discarded the partial bridge dense had found. So hybrid scored *worse than dense* on alias
queries while scoring better on rare exact names. Query-time alias expansion into the lexical arm
(weight 0.3) fixes it: Laurie ↔ Theodore Laurence goes 0/5 → 5/5 sparse, 0/5 → 4/5 hybrid. The
`beth → elizabeth` link is deliberately absent, "elizabeth" appears in 411 Pride & Prejudice chunks
and 2 Little Women chunks, so it would drag Austen into every Alcott query. See D-25.

**Retrieval on the harder generated set** (60 paraphrased questions, gold passage known, k=8).
The hand-written set saturated, at 20/20 when this was built and at 24/24 now, so it could not answer "did this change help?". This one can:

| mode | strict recall | strict MRR | chapter recall | chapter MRR |
|---|---|---|---|---|
| hybrid | **86.7%** | 0.4613 | **96.7%** | 0.7247 |
| dense | 83.3% | **0.5181** | 95.0% | **0.8006** |
| sparse | 38.3% | 0.2314 | 68.3% | 0.4131 |

Hybrid has the better recall, dense the better ordering, fusion pulls in passages dense misses and
then ranks them worse. That diagnosis is what made the reranking question answerable.

**Held-out set** (60 further cases from disjoint chunks, never tuned against):

| mode | strict recall@8 | chapter recall@8 |
|---|---|---|
| hybrid | 76.7% [66.7-86.7] | 88.3% [80.0-95.0] |
| dense | 75.0% [63.3-85.0] | 86.7% [78.3-93.3] |
| sparse | 41.7% [28.3-55.0] | 65.0% [51.7-78.3] |

**Reranking is ON, and that reverses an earlier decision.** It first shipped off on dev-set evidence
(+1.6pp recall for double the cost). That was a ceiling effect, dev chapter recall was already 96.7%.
A **paired** bootstrap on held-out data, which is the correct test when both configurations run on the
same queries, shows the gain clearly:

| paired comparison, held-out | difference | 95% CI | verdict |
|---|---|---|---|
| chapter recall@8 | **+8.3pp** | [1.7, 16.7] | **significant** |
| chapter MRR | +0.1410 | [0.055, 0.225] | **significant** |
| strict recall@8 | +8.3pp | [-1.7, 16.7] | not significant |

It buys genuine recall, not reordering: retrieval over-fetches 24 candidates and cuts to k=8, so a
better ranking selects a better eight. Costs ~$0.0065 and ~4.8s per query. `RERANK=false` disables it.

**Contextual retrieval: tested in its cheap form, and rejected on evidence.** Prepending book and
chapter titles before embedding *lowered* dense strict recall from 83.3% to 71.7%. A constant
per-chapter prefix makes chunks within a chapter more alike, which is the opposite of what retrieval
needs. Anthropic's version works because its prefix is chunk-specific and therefore discriminating, 
metadata is not context. The full technique needs one LLM call per chunk (1,330 here), which the
deployment's rate limit makes impractical. See D-21.

**Multi-hop retrieval.** Rare proper nouns appearing in results but not in the query are followed up
automatically (one embedding call each, no LLM). This fixes the only failure any test here has found:
a question whose second half is reachable only by a name learned from the first half. Multi-needle
goes **3/4 → 4/4**. Gated on term rarity, "Elizabeth" is in 411 chunks and chasing it would flood
every query; "Sir Marcus Vane" is in 2. See D-31, including how a noisy metric caused this to be
switched off before better measurement switched it back on.

**Needle-in-a-haystack.** Synthetic passages planted into the corpus (in memory, index untouched),
each with two question forms: `literal` reuses the needle's wording, `latent` requires an associative
hop, following NoLiMa. Shipped configuration scores **100% retrieved / answered / cited**, mean rank
1.00, no position bias across depth.

The ablation is the informative part, sparse retrieval collapses to **1/6** on camouflaged latent
questions, reproducing NoLiMa's finding that removing the lexical path blinds BM25:

| mode | isolated | camouflaged | latent only (camouflaged) |
|---|---|---|---|
| hybrid | 12/12 | 12/12 | 6/6 |
| dense | 12/12 | 12/12 | 6/6 |
| sparse | 9/12 | 7/12 | **1/6** |

A first needle set scored 100% everywhere and measured nothing. The needles were *semantically
isolated*, not merely lexically distinct. A second set camouflaged on topics the corpus is dense in
fixed that. See D-28, including the two harness bugs a negative control caught.

**Latency and cost, measured:**

| | |
|---|---|
| Dense search, full scan | 4–6 ms |
| BM25 search | 2–4 ms |
| Query embedding (network) | 250–860 ms |
| Verbatim reuse scan, 422k pairs | ~300 ms |
| Full cross-book semantic sweep, 422k pairs | ~780 ms |
| Simple question, end to end | ~15 s, ~$0.021 |
| Multi-part question (2 searches) | ~20 s, ~$0.035 |
| Follow-up needing no retrieval | ~5 s, ~$0.006 |
| Judged comparison | ~11 s, ~$0.012 |
| One-off index build | ~130 s, ~$0.07 |

These are measured from real sessions, not from the eval loop, and they are higher than a
per-retrieval estimate suggests. **Reranking costs per *search call*,
not per question.** The assistant commonly issues two searches for a two-part question ("describe
each book"), so it pays the rerank tax twice, roughly $0.013 and ~8s of the totals above. That is
the honest price of the +8.3pp recall in D-20, and it is why `RERANK=false` is a supported
configuration rather than a hidden flag.

Cost figures use **assumed** token rates. There is no published price for this deployment. They
are configurable and are meant to make cost visible and relative, not billing-accurate.

---

### The two parameters that had never been swept

Both were blocked on an answer eval too noisy to decide anything (D-31). Once that became a real
instrument, both were run.

**`k`**, held-out set, n=60, hybrid, no rerank. Chapter recall is flat from k=6 to k=12 and MRR moves
0.03 across a fourfold change in k, every interval overlapping. Answer quality: k=4 → 9/10, k=8 →
10/10, k=16 → 10/10, which at n=10 is a one-case difference and not a result. **`k` is therefore a
context-cost decision, not a quality one**. Every extra passage is ~350 words of prompt paid on
every question. Claiming k=8 retrieves *better* would be inventing a finding (D-55).

**Overlap**. Three full re-ingests:

| overlap | chunks | index | ingest | chapter recall@8 |
|---|---|---|---|---|
| 0 | 1,087 | 4.2 MB | 86s / $0.052 | **93.3%** [86.7–98.3] |
| 60 (shipped) | 1,359 | 5.3 MB | 143s / $0.068 | 88.3% [80.0–95.0] |
| 100 | 1,563 | 6.1 MB | 152s / $0.080 | 91.7% [85.0–96.7] |

Zero overlap scored highest while being smallest and cheapest, and the shipped value scored lowest, 
all within overlapping intervals. It is kept for a reason the measurement cannot support, stated as
such in D-56.

These three rows were measured before D-84 removed 28 chunks of apparatus from the corpus, so the
absolute counts are each about 2% above what the same settings would produce now. They are left as
measured rather than rescaled, because a number in a results table should be one that was observed.
The comparison between rows is unaffected: the same sections were present in all three.

### Evaluated by use case, not only by mechanism

Grouping the same cases by what they are *for* rather than by how the system works found the set was
lopsided. G1 had no cases and G4 had one, while the overall number looked healthy.

| | use case | cases |
|---|---|---|
| G1 | explore and understand a book | 5 |
| G2 | answer about specific parts | 9 |
| G3 | find relevant passages | 28 |
| G4 | compare across books | 6 |
| guard | refuse what is out of scope | 4 |

The first G1 case scored **0/3 on groundedness on every run**: asked what a book is about, the
assistant retrieved eight passages and summarised those, which cannot describe a novel. The notes
already existed and it had no tool to read them. Adding `about_the_book` took it to 3/3 in half the
time (D-57).

### Unit tests

71 offline tests on `node:test`, no new dependency, no API key. They answer a different question from
the eval: not "is this any good" but "does this still do what it is documented to do". Writing them
found that the citation audit could not be tested without a 5 MB index artefact, which for an output
guardrail is a defect in itself (D-54).

---

## Assumptions

Named here rather than left implicit, because a reader cannot check what a system takes for granted
unless it says so.

**About the reader.** The user is a publisher's editorial desk, an acquiring editor or a rights and
legal desk, not an engineer. Every interface choice follows from that: passages shown verbatim,
citations that resolve to *Book, Chapter*, no internal vocabulary, and no number on screen the reader
cannot act on. If the real user were a developer, a CLI would beat all of it.

**About the corpus.** Everything here is measured on **two novels by two nineteenth-century women
writing domestic fiction**. That is a narrow and unusually homogeneous corpus: two random passages
already score 0.4316 for similarity, which is why no similarity number is ever shown without that
floor beside it. Conclusions about retrieval generalise less than the confidence intervals suggest,
because the intervals describe sampling noise within this corpus, not the gap to a different one.

**That the corpus is the books.** It was not. Gutenberg ships a critical introduction, a publisher's
catalogue and transcriber's notes, and 28 chunks of that were indexed and winning thematic searches
until the last QA pass (D-84). It is named here because nothing in the system was positioned to
notice it: every check validates the path from evidence to answer, and this was upstream of all of
them.

**About cost.** The USD figures in the traces and this README are **estimates**. There are no
published rates for this deployment, so the prices in `.env.example` are assumed, and the numbers are
built to make cost visible and relative rather than billing-accurate (D-11).

**About the evaluation.** The generated eval set was written by a model from the same family as the
system it tests, and "answerable only from this chunk" is that model's judgement rather than a
verified property. The answer half is LLM-judged and moves 47 to 49 out of 52 across runs of
identical code, so it is quoted as a range and never used to resolve a small difference. The
deterministic half does not move at all.

**About deployment.** Local, single user, no authentication, no concurrency, one process holding the
index in memory. The README's next-steps section says what changes first if any of that stops being
true.

**That a chapter is the unit an editor cites.** The hard rule that a chunk never crosses a chapter
follows from it, and so does the citation format. A corpus without chapters, or a user who cites page
numbers, would need a different address.

---

## Where it is weak

Each of these was reproduced by using the tool, and each is held by a named eval
case so it stays visible.

**Compound questions are the weakest input.** *"Do these books share copied
wording? Also give me the word counts"* needs two different capabilities in one
turn. Across five runs of identical code it passed twice and failed three times.
The failure is consistent: the answer quotes the comparison's own sentence,
*"zero shared phrases were found between these books"*, as though it came from a
novel, and carries two or three claims the follow-up search cannot support. Asked
as two separate questions, both are clean. Held by `ui-mixed-count`, left failing
rather than tuned late, since a prompt rule aimed at it would need its own
measurement to justify.

**Quoting the system's own output as book text is the specific failure mode.**
Quotation marks here promise the book's words, so the quotation check compares
them against the retrieved text by string rather than by judgement. Prompt rule 4a
forbids it and names the two phrasings that tend to trigger it: the comparison's
findings and the chapter survey's stated standard. It still occurs, routinely on a
compound question and in 1 run of 9 on the survey. A prompt rule moves the rate;
the string check is what makes the guarantee.

**It can supply a cause the passages do not contain.** Asked what happens when Amy
burns Jo's manuscript, it explains that Amy did it because Jo refused to take her
to the theatre. That is true of *Little Women* and absent from the retrieved
passages, which is what rule 4b targets: correct, unsupported, and
indistinguishable from the rest of the answer. It appeared in three runs of four,
on one or other of the two cases covering that chapter, so `ans-amy-burn` and
`g1-chapter-what` both hold it.

This one is also a useful result about the instruments. The groundedness judge
caught it unanimously, 0 votes of 3; the claim audit checked 9 to 16 claims on the
same answers and reported none unsupported. The two guardrails see different
things, which is the case for running both.

**A concept can be surveyed, not counted.** *"How many dramatic scenes"* returns a
count of chapters judged from summaries, with the standard applied, not a count of
scenes. Scene-level counting would need a pass over all 1,330 chunks, roughly $4
and half an hour, and is not built (D-98).

**That survey is not repeatable.** Asked the same question three times, *Little
Women* returned 7, 8 and 10 chapters of 47. A word count is exact because it is
arithmetic; a survey is a model applying a stated standard to 47 summaries, and
the judgement moves between runs. The answer states which of the two it performed,
which limits the harm without removing it. Held by `ui-survey-chapters`.

**The comparison operates passage to passage.** It finds text that resembles other
text. It does not assess whether a plot is derivative, only whether two passages
are close in meaning or share wording.

**Whole-book answers come from notes written at ingest**, not from the text at
question time, so an error in a note propagates to the answer. 322 of 322
quotations inside those notes verify verbatim, which checks the quotations rather
than the prose around them (D-73).

**Everything the interface suggests is an eval case.** The five example questions
on the opening screen all run in `npm run eval`, so a suggestion cannot drift away
from what the system actually does.

---

## Known limits and next steps

The constraints a reviewer would want stated, with what each would take to lift.

**The instruments**

- **The answer eval is usable, but small.** It began as 3 LLM-judged cases swinging **1/3–3/3** on
  identical code, which was not enough to decide anything (D-31). It is now 22 cases with
  majority-of-three judging and variance collapsed to **9/10–10/10**. Good enough to catch a real
  regression; not precise enough to resolve a two-point difference. Which is why D-55 concluded that
  `k` could not be chosen on quality at all, a conclusion **since superseded**: context precision
  resolves k cleanly where the answer judge could not, and it prefers a smaller k than the one
  shipped (D-88).
- **The generated eval shares a model family with the system it tests**, and "answerable only from
  this chunk" is the generator's judgement, not a verified property. Some questions are answerable
  from neighbouring chunks, so strict recall understates real performance. It is a relative
  instrument for comparing configurations, not an absolute score.
- **The hand-written retrieval set is loose by design.** 24 cases; one passes if any retrieved
  passage from the right book contains any expected term. It guards against breakage, not against
  subtle quality loss. And it saturates at 24/24 from k=4 to k=12, so it cannot rank configurations.
- **Topical coverage has no real metric.** Every retrieval case has one findable target passage, so
  recall@k is undefined for an abstract query such as *crime*. The topic search (D-53) is guarded by
  two coverage assertions confirming both books stay reachable, which is weaker than a recall
  measure. A proper one needs a labelled topic set built independently of the system it scores.

**The parameters**

- **Overlap is not justified by its own measurement.** Zero overlap scored the *highest* chapter
  recall (93.3% vs 88.3%) with a 20% smaller index and a 40% cheaper ingest; the shipped value scored
  lowest of the three tested, all within overlapping intervals. Chapter recall cannot see what
  overlap is supposed to protect, an answer cut in half at a seam, so that instrument was built too,
  and it could not separate them either: 25/30 against 24/30. Three measurements, one designed
  specifically to detect the effect, none can tell 60 words from none (D-56, D-68).

  One dependency had to be removed before that decision was actually free. The quotation check
  originally treated chunks as its authority, so a quotation crossing a seam belonged to no single
  entry, and 545 of 545 straddling spans were reachable only because the overlap carried the seam. A
  guardrail therefore depended on a parameter this section invites you to change. The check is
  chapter-scoped now, so the overlap value can be changed on its own merits (D-86).
- **Chunk size and dimensions were both swept, and both defaults held** (D-71). 3,072 dimensions buy
  three points of chapter recall for three times the memory, with intervals that overlap almost
  entirely and the hand-written set moving the other way. Re-test either in two minutes:
  `EMBEDDING_DIMS=3072 npm run ingest`. The sweep design is itself a finding: testing one factor at a
  time was the wrong shape, and D-72 says why.

**The retrieval**

- **Rare-name queries are retrieved but mis-ordered.** Searching *Mrs Younge* returns both passages
  containing the name at ranks 4 and 7, under chunks mediocre in both arms. RRF rewards agreement,
  and two middling agreements outscore one perfect lexical match. The obvious fix (weight the lexical
  arm by query IDF) was built, measured, and **made every metric worse**, because 32 of 60 held-out
  queries trip any workable threshold. Documented rather than fixed (D-58).
- **This is not a plagiarism detector.** Embedding similarity finds *thematic and structural*
  resemblance; the verbatim check beside it finds shared 8-word sequences. Neither is character
  n-gram or suffix-array matching, which is the instrument a rights desk would eventually want.

**The generation**

- **Two guardrails run in code, and both report rather than rewrite.** The citation audit checks
  that every id resolves and was retrieved (D-18). Per-claim verification then checks each sentence
  against every passage retrieved, and names the information that is missing (D-61). Measured at 6
  flags across 193 claims, agreeing with the groundedness judge on the one answer both examined.
  What remains unguarded is a claim supported by a *retrieved* passage that the reader would still
  dispute; neither instrument reads the books.
- **The assistant tends to over-frame.** Attributing narration to a speaker, or adding sequence
  ("after hardship and grief") the passage does not state. Prompt rules reduced it; the G1 and G4
  cases still catch it occasionally. Not eliminated.
- **Conversation history is replayed in full each turn.** Fine at this length, needs windowing in a
  long session.

**The interface**

- **The progress panel reports tool calls, not thinking.** While a turn runs, each line is something
  that actually happened: a search, a comparison, a chapter read. A turn that can be answered from
  passages already retrieved calls no tool, so it shows that it is using what was already found and
  little else, and a turn that spends its time in the model rather than in a tool looks quieter than
  it is. The answers are correct either way; what is missing is a report of the reasoning phase
  alongside the tool phase. Next step is to stream a line when the model starts deliberating, so the
  panel measures elapsed work rather than only tool boundaries.
- **Threads are per-browser, in localStorage.** Writes merge across tabs so two tabs no longer
  overwrite each other, but two tabs editing the *same* thread cannot be truly reconciled without
  turn-level history; the fuller copy wins. Server-side threads would remove the question entirely,
  and are a schema rather than a feature.

**The deployment**

- **Runs locally, as specified.** No auth, no rate limiting, no multi-tenancy, and the index lives
  in one process's memory. Making this multi-user is not a matter of adding a login screen:
  - **Storage.** The index is a file loaded at boot. Two users are fine; two hundred books are not.
    That is where a real vector store earns its place (D-05), and where chunk metadata wants a
    database rather than a JSON blob.
  - **Identity.** Sessions, and a per-user scope on every retrieval call. Book scope is already
    enforced in the tool layer (D-45), so the seam exists: it takes a user id rather than a
    selection.
  - **Cost control.** Traces already carry per-request cost (D-11). Metering needs them persisted
    per user, plus a ceiling, because an agent loop against a paid API is exactly where one account
    can spend everyone's budget (D-13).
  - **Rate limiting and abuse.** Nothing here throttles. The provider's filter catches the obvious
    jailbreaks (D-75) and is not a substitute for a limit of our own.
  - **Conversation storage.** History is replayed from the client each turn, so nothing persists.
    Server-side threads are a schema and a migration, not a feature.
- **Reranking is ON** (+8.3pp chapter recall, 95% CI [1.7, 16.7]), costing ~$0.0065 and ~4.8s per
  query. `RERANK=false` roughly halves latency and cost at a measured quality loss (D-20).

---

## Layout

```
backend/src/
  config.ts              env, paths, tunables
  azure.ts               Azure client, retry w/ Retry-After, token accounting
  trace.ts               per-request spans, usage, cost
  ingest/
    parse.ts             Gutenberg HTML -> chapters
    chunk.ts             chapter-aware, paragraph-safe chunking
    build-index.ts       parse -> chunk -> embed -> persist
    summarise.ts         chapter and book notes, verified against the text
  retrieval/
    store.ts             in-memory vectors, cosine scan
    bm25.ts              BM25, ~110 lines, no dependency
    hybrid.ts            RRF fusion, ablation modes
    aliases.ts           Lizzy <-> Elizabeth, in the lexical arm only
    rerank.ts            LLM second stage over the fused candidates
    expand.ts            multi-hop follow-up on rare entities
    broaden.ts           topic search: one word -> several registers, round-robin
    similar.ts           cross-book pairs, baseline, diversity, judge
    reuse.ts             verbatim 8-word shingles. A different question
  agent/
    tools.ts             seven tool defs + executors, book scope enforced here
    chat.ts              bounded tool-calling loop, grounding prompt
    verify.ts            citation audit: do the cited ids resolve
    quotes.ts            quotation check, in code: is the quoted text real
    claims.ts            per-claim check: unsupported, recovered, or inference
  eval/
    cases.json           52 cases, each tagged with the use case it defends
    run.ts               reports by mechanism AND by use case
    generate.ts          builds the harder set from the corpus
    run-generated.ts     harder generated set, bootstrap CIs
    boundary.ts          can a passage spanning a chunk seam be reassembled (D-60, D-72)
    tamper.ts            plants known defects, measures guardrail recall (D-65)
    notes.ts             are the chapter notes faithful to the chapters (D-73)
    compare.ts           paired significance test between two saved runs
    niah.ts              needle-in-a-haystack, single and multi
    quality.ts           context precision and answer relevance, the two axes
                         the rest of the suite does not measure (D-88)
  test/                  77 offline tests: unit, ingest, quotes, docs (npm test)
  server.ts              Fastify API

frontend/src/App.tsx     one screen: threads, conversation, books in context
frontend/src/styles.css  design tokens, light and dark, responsive

data/books/              source HTML, as supplied
data/summaries.json      chapter and book notes, committed, not a build artefact
data/index/              build artefact (rebuild with `npm run ingest`)
```
