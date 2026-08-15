import { config } from '../config.js';
import { chat } from '../azure.js';
import type { Trace } from '../trace.js';
import type { Scored } from './store.js';

/**
 * LLM-based reranking.
 *
 * The standard second-stage reranker is a cross-encoder (Cohere Rerank,
 * BGE-reranker). It takes the query and a passage *together*, so it can attend
 * across both, which a bi-encoder embedding cannot. That is why it is more
 * accurate and why it cannot be precomputed.
 *
 * This deployment exposes only a chat model and an embedding model, so no
 * cross-encoder is available. The substitute is to give the chat model the query
 * and the candidate passages and ask it to order them. Slower and dearer than a
 * real cross-encoder (one extra generation per query) but it tests the same
 * hypothesis: does a second pass that sees query and passage jointly beat
 * first-stage retrieval?
 *
 * ON by default. D-19 shipped it off on dev-set evidence; D-20 reversed that on a
 * held-out paired bootstrap: +8.3pp chapter recall, 95%% CI [1.7, 16.7].
 */

const SYSTEM = `You rank passages by how well they answer a question.

You will get a question and numbered passages. Return the passage numbers ordered
best-first. Judge only whether the passage contains information that answers the
question, not whether it is well written or interesting.

A passage that merely shares topic or vocabulary with the question does NOT answer it.
Prefer the passage containing the specific detail asked about.

Return JSON: {"order":[3,0,7,...]} listing every passage number exactly once.`;

export async function rerank(
  query: string,
  candidates: Scored[],
  k: number,
  trace?: Trace,
): Promise<Scored[]> {
  if (candidates.length <= 1) return candidates.slice(0, k);

  const body =
    `QUESTION: ${query}\n\n` +
    candidates
      .map((c, i) => `### Passage ${i}\n${c.chunk.text.slice(0, config.retrieval.rerankChars)}`)
      .join('\n\n');

  let message: { content: string | null };
  try {
    ({ message } = await chat({
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: body },
      ],
      jsonMode: true,
      maxTokens: 400,
      trace,
      label: 'llm:rerank',
    }));
  } catch (err) {
    // Reranking is an optional quality pass over an already-usable ranking, so
    // any failure degrades to first-stage order rather than failing the request.
    //
    // This is not hypothetical: Azure's content filter returns a 400
    // ResponsibleAIPolicyViolation on some passages of these novels. A 400 is
    // correctly non-retryable, so without this catch one filtered passage kills
    // the whole query. Content filters firing on 19th-century literature is a
    // real operating condition for this corpus, not an edge case.
    const msg = (err as Error).message ?? '';
    console.warn(
      JSON.stringify({
        type: 'rerank_failed',
        reason: /content_filter|ResponsibleAI/i.test(msg) ? 'content_filter' : 'error',
        detail: msg.slice(0, 160),
      }),
    );
    return candidates.slice(0, k);
  }

  try {
    const order: number[] = JSON.parse(message.content ?? '{}').order ?? [];
    const seen = new Set<number>();
    const ranked: Scored[] = [];
    for (const i of order) {
      if (Number.isInteger(i) && i >= 0 && i < candidates.length && !seen.has(i)) {
        seen.add(i);
        ranked.push(candidates[i]);
      }
    }
    // Anything the model omitted keeps its original relative order at the back,
    // so a partial response degrades to "first-stage ranking" rather than
    // silently dropping candidates.
    candidates.forEach((c, i) => { if (!seen.has(i)) ranked.push(c); });
    return ranked.slice(0, k);
  } catch {
    return candidates.slice(0, k);
  }
}
