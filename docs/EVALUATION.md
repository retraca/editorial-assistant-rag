# How this system is measured

Eight instruments, each answering a question the others cannot. This document says what each one is
for, what it cannot see, and how to add to it.

The reasoning behind the numbers lives in [DECISIONS.md](../DECISIONS.md). This is the operating
manual.

---

## The instruments

| | command | needs a key | answers |
|---|---|---|---|
| Unit tests | `npm test` | no | do the deterministic pieces still behave |
| Case set | `npm run eval` | yes | is the system good, per use case |
| Generated set | `npm run eval:hard` | yes | which of two configurations is better |
| Needle | `npm run eval:niah` | yes | can it find one planted fact and use it |
| Boundary | `npm run eval:boundary` | yes | does chunk overlap earn its cost |
| Tamper | `npm run eval:tamper` | yes | does the guardrail catch a planted defect |
| Paired test | `npm run eval:compare` | no | is a difference real or noise |
| Quality | `npm run eval:quality` | yes | were the passages relevant, does the answer address the question |

The case set also measures the **claim audit** against the groundedness judge on every run, printing
how often it fires on answers the judge passed. That number is the one that decides whether the
guardrail is worth having: a check that cries wolf on good answers trains the reader to ignore it,
and this system has learned that once already (D-14).

---

## 1. Unit tests

```bash
npm test        # 77 tests, offline, no API key, about three seconds
```

Four files, and they answer a different question from everything below: not *is this any good* but
*does this still do what it is documented to do*. Free, deterministic, and a failure is always a bug.

- `unit.test.ts` covers chunking, BM25, aliases, RRF and the citation audit.
- `ingest.test.ts` covers Gutenberg parsing, the similarity-to-words translation, cost accounting, and
  the invariant that a chapter reads exactly as the book rather than as a reconstruction (D-85).
- `quotes.test.ts` covers the verbatim quotation check, including the cases that fooled it and the
  545 seam-straddling spans that must not be called misquotes (D-86).
- `docs.test.ts` is the drift guard: it fails when the documentation describes tools, surfaces, case
  counts, scripts, environment variables or module names that do not match the code (D-59).
- `docs.test.ts` checks that the documentation describes the system that exists, and that the prose
  rules hold. See [D-59](../DECISIONS.md). It now also checks the claimed test count and that every
  source module reaches the README layout, both of which drifted while it was watching other things.

Every case is a bug that was actually hit or an invariant a decision depends on. None of them assert
that a function returns the type it declares.

**What they cannot see:** whether any answer is correct.

---

## 2. The case set

```bash
npm run eval                      # 52 cases
npm run eval -- --retrieval-only  # the 24 deterministic ones, free and instant
npm run eval -- --only=g4         # one group, while iterating
```

Reported twice, and the second view is the one that matters:

```
--- by mechanism ---        --- by use case ---
retrieval  24/24            G1  5/5   explore and understand a book
topic       2/2             G2  8/9   answer about specific parts
answer     19/22            G3 28/28  find relevant passages
refusal     4/4             G4  4/6   compare across books
                            guard 4/4  refuse what is out of scope

--- claim audit (D-61) ---
checked 290 claims
  4 unsupported by the books (a defect)
  19 the assistant's own reading (marked, not an error, D-63)
fired on 0/17 answers the judge passed  (false positives)
fired on 2/5  answers the judge failed  (catches)
```

The mechanism view says which *part* broke. The use-case view says which *job* is unguarded, and it
is the one that found G1 had no cases at all while the overall score read 36/37. See
[D-57](../DECISIONS.md).

One run, shown for shape. The total moves 47 to 49 of 52 across runs of identical code and the
groups move with it, G4 most of all. Never read a single run as a measurement.

**Case types.** `retrieval` (a term must appear in a retrieved passage), `answer` (LLM-judged
groundedness, majority of three, plus keyword and citation checks), `refusal` (must decline),
`topic` (both books reachable for an abstract subject).

**Adding a case.** Append to `src/eval/cases.json`:

```json
{
  "id": "g2-example",
  "type": "answer",
  "goal": "G2",
  "query": "What does Jo want to become?",
  "mustMention": ["writ"],
  "mustNotMention": ["score", "0.6"],
  "cites": true
}
```

`mustNotMention` is how a rule becomes a test: it is what stops a comparison answer leaking `0.64` at
the reader. `cites: false` is for questions answered from collection facts, which have no passage
behind them. Demanding a citation there teaches a model to invent one.

**What it cannot see:** anything no one thought to write a case for. Every gap in this system was
found by adding a case, never by the existing ones going red.

---

## 3. The generated set

```bash
npm run eval:hard -- --file=cases-heldout.json --k=8 [--mode=dense] [--rerank]
```

60 paraphrased questions with a known gold passage, plus 60 more held out from disjoint chunks that
were never tuned against. The hand-written set saturates at 24/24 from k=4 to k=12, so it cannot rank
configurations. This one can.

Reports strict recall (the exact gold chunk), chapter recall, and MRR, each with a bootstrap 95%
confidence interval. **Read the intervals.** Two configurations whose intervals overlap are not
distinguishable, and reporting them as a ranking is how a project convinces itself of a result it
does not have.

**What it cannot see:** it shares a model family with the system it tests, and "answerable only from
this chunk" is the generator's judgement rather than a verified property. Treat it as a relative
instrument, not an absolute score.

---

## 4. Needle in a haystack

```bash
npm run eval:niah [-- --no-answer] [--mode=sparse] [--no-rerank]
```

Plants synthetic passages in the corpus and measures three separate things: whether the needle is
**retrieved**, whether the answer **uses** it, and whether it is **cited**. A system can retrieve
perfectly and still answer from memory, and only separating those catches it.

Each needle is asked in two forms: a **literal** one sharing wording with the planted text, and a
**latent** one that shares meaning but no words. The gap between them is the honest measure of
whether retrieval is doing anything more than string matching.

The multi-needle variant plants several and asks a question requiring all of them, which is the only
test in this repo that has ever caught an aggregation failure.

**What it cannot see:** planted text is not natural prose, so it is easier to find than the real
thing.

---

## 5. The boundary set

```bash
# generate once against a zero-overlap index, where the seams are real cuts
CHUNK_OVERLAP_WORDS=0 npm run ingest
npm run eval:boundary -- --generate

# then measure any chunking configuration against it
npm run eval:boundary [-- --k=8] [--show-misses]
```

Built to answer one question the other instruments cannot: **can the system reassemble a passage
that spans a chunk boundary?**

It began as a test of chunk overlap and turned out to be the diagnostic for a whole family of
settings. Chunk size, overlap, neighbour expansion and `k` all change the answer, and they interact:
the grid in [D-72](../DECISIONS.md) shows 350-word chunks with neighbours reaching 100% while
200-word chunks cannot get past 73% no matter how many neighbours are added.

**Run it as a grid, not one factor at a time.** Sweeping these separately was the mistake D-72
corrects.

The overlap sweep in [D-56](../DECISIONS.md) found the settings indistinguishable on chapter recall,
with zero overlap scoring highest while producing the smallest index. That result was reported and
deliberately not acted on, because chapter recall is blind to the thing overlap exists to prevent: an
answer cut in half at a chunk seam. If the right chapter comes back either way, the metric passes.

This set asks questions whose answer needs **both sides of a seam**, and passes only when the
retrieved passages contain a distinctive term from each side. Expectations are terms rather than
chunk ids, because changing the overlap re-chunks the corpus and would invalidate any id-based gold:
the very change being measured would destroy the measurement.

The generator is not trusted about its own output. Each proposed term is verified to occur on its own
side of the seam and not on the other, and cases that fail that check are discarded.

---

## 6. The tamper set

```bash
npm run eval:tamper -- --capture   # once, records 14 real answers and their passages
npm run eval:tamper                # measure
```

Answers the question the case set cannot: **how many real defects does the output guardrail catch?**

The case set can only measure that against the one or two answers the judge happens to fail on a
given run, which is a coin toss with a denominator. This corrupts real answers in four known ways,
a dropped negation inside a quotation, a swapped word inside a quotation, a fabricated sentence, an
altered number, and counts how many come back.

Current: **96% recall**, with negation, misquote and fabrication all at 100%.

**Read the control row carefully.** It reports flags on *unmodified* answers, and they are candidate
false positives rather than confirmed ones. On the first run all six were worth inspecting: three
were bugs in the quotation checker, now fixed and tested, and three were genuine defects in the
original answers, including the assistant quoting this system's own comparison phrasing back as
though it came from the books. See [D-65](../DECISIONS.md).

---

## 7. The paired test

```bash
npm run eval:hard -- --save=a.json --mode=hybrid
npm run eval:hard -- --save=b.json --mode=dense
npm run eval:compare -- a.json b.json
```

Compares two runs **case by case** rather than comparing their averages. The same 60 questions are
answered by both configurations, so the pairing removes question difficulty from the comparison and
the interval tightens.

This is what showed that hybrid and dense are not distinguishable on aggregate, overturning a claim
that had already been written down as fact. See [D-24](../DECISIONS.md).

---

## 8. Context precision and answer relevance

```bash
npm run eval:quality                                    # both, ~$1
npm run eval:quality -- --only=context --k=4,8,12       # relevance of what was retrieved
npm run eval:quality -- --only=relevance                # does the answer address the question
```

The two axes everything above misses. Seven instruments measure whether the evidence was found and
whether the answer is faithful to it. Neither asks **how much of what was retrieved was any use**, or
**whether the answer addressed the question that was asked**. Both are defaults in Ragas, which is
how the gap was found rather than by introspection. See [D-87](../DECISIONS.md).

**Context precision** judges every retrieved passage for relevance, not just the gold one:

| k | precision@k | rank-weighted | irrelevant passages per question |
|---|---|---|---|
| 4 | 45.0% [36.7-54.2] | 94.9% [87.1-99.4] | 2.2 |
| **8 (shipped)** | 29.2% [23.8-35.8] | 94.1% [88.7-98.2] | 5.7 |
| 12 | 19.6% [14.3-26.2] | 95.5% [89.0-99.4] | 9.6 |

This settled a question the suite had recorded as unanswerable. D-55 concluded `k` could not be
chosen on quality because the answer judge could not separate k=4 from k=8. Precision separates them
with non-overlapping intervals, and **prefers a smaller k than the one shipped**. The paired test
puts every recall difference inside noise, so the case for k=8 now rests on rank-weighted precision
being flat: the useful passages are on top at every k, so extra passages are appended below the
evidence rather than displacing it. Read [D-88](../DECISIONS.md) before changing `RETRIEVAL_K`.

**Answer relevance** asks a model what question an answer actually answers, embeds those against the
real question, and takes the mean cosine:

| | |
|---|---|
| relevance | 0.7019 [0.6462-0.7567] |
| baseline, this question against a *different* answer | 0.2967 [0.2652-0.3324] |
| noncommittal | 0 of 17 |

**The baseline is the measurement.** Two questions about the same two novels sit close in embedding
space before anything is done, the same reason a raw similarity score is never shown alone (D-33).
The three lowest-scoring answers are all three comparison cases, which is a second instrument landing
on the weakness the case set already shows for G4.

---

## What I would measure next

The instruments above cover retrieval and faithfulness. These are the gaps I would close next, in
roughly this order.

- **Noise sensitivity.** The tamper set corrupts *answers*; nothing yet corrupts the *retrieved
  context* and measures the effect on the answer. This is the next instrument to build.
- **Claim recall.** The claim audit measures its own precision, not what it misses. Closing this
  needs written reference answers for the 22 answer cases.
- **Retrieval precision@k and F1.** Not reported, because with exactly one gold chunk per case
  precision@k is mechanically `1/k` on a hit and F1 reduces to `2R/(1+k)`, a function of recall that
  carries no information recall does not already carry. Section 8 measures the precision question
  that applies here. A meaningful F1 needs every relevant passage labelled per query, which means
  1,330 chunks against 60 queries.
- **Topical coverage.** Every retrieval case has one findable target passage, so recall@k is
  undefined for an abstract query such as *crime*. Two coverage assertions guard it today; a real
  metric needs a labelled topic set.
- **Whether a supported claim is correct.** Both guardrails check a sentence against retrieved
  passages (D-18, D-61). Neither has read the books, so a claim supported by a retrieved passage that
  an editor would still dispute passes both. Closing this needs an editor in the loop.
- **Latency and cost under concurrency.** Traces record both per request; nothing measures them under
  load.

---

## The rule

An instrument that cannot be run is not an instrument. Everything above runs from a clean checkout
with one command, the deterministic half needs no API key, and the numbers in the README come from
these commands rather than from memory.
