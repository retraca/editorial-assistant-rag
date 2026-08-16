import { config } from './config.js';
import type { Trace } from './trace.js';

/**
 * Thin Azure OpenAI client over global fetch.
 *
 * No SDK: two endpoints are used (chat/completions and embeddings) and the
 * wire format is stable. See DECISIONS.md D-09.
 *
 * Note `max_completion_tokens`: this deployment rejects the older `max_tokens`
 * parameter outright with a 400. Verified against the live API.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatOpts {
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  trace?: Trace;
  label?: string;
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface AzureError extends Error {
  status?: number;
  retryAfterMs?: number;
}

/**
 * Retry with exponential backoff, but honour `Retry-After` when the server
 * sends it. This runs against an S0 tier deployment whose 429 says "retry after
 * 45 seconds"; a blind 400ms*2^n schedule tops out around 6s and burns every
 * attempt inside the window the server already told us to wait out.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const { status, retryAfterMs } = err as AzureError;
      // Only retry transient failures; a 400 is a bug in our request and
      // retrying it just burns quota.
      if (status !== undefined && !RETRYABLE.has(status)) throw err;
      if (i === attempts - 1) break;
      const backoff = 400 * 2 ** i + Math.random() * 200;
      const wait = Math.max(backoff, retryAfterMs ?? 0);
      console.warn(`[azure] ${status ?? 'network'}, retrying in ${Math.round(wait / 1000)}s (attempt ${i + 1}/${attempts})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/** Azure sends seconds; some gateways send an HTTP date. Handle both. */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/**
 * The two providers differ in three places and nowhere else: the URL, the header
 * that carries the key, and whether the model is named in the path or the body.
 * Everything downstream, retries, tracing, response shape, is identical, which is
 * why this is a branch here rather than a second client.
 */
const openaiMode = () => config.provider === 'openai';

const chatUrl = () => (openaiMode()
  ? `${config.openai.baseUrl}/chat/completions`
  : `${config.azure.endpoint}/openai/deployments/${config.azure.chatDeployment}/chat/completions?api-version=${config.azure.apiVersion}`);

const embedUrl = () => (openaiMode()
  ? `${config.openai.baseUrl}/embeddings`
  : `${config.azure.endpoint}/openai/deployments/${config.azure.embeddingDeployment}/embeddings?api-version=${config.azure.embeddingApiVersion}`);

async function post(url: string, body: unknown): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (openaiMode()) headers.Authorization = `Bearer ${config.openai.apiKey}`;
  else headers['api-key'] = config.azure.apiKey;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${openaiMode() ? 'OpenAI' : 'Azure'} ${res.status}: ${text.slice(0, 500)}`) as AzureError;
    err.status = res.status;
    err.retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
    throw err;
  }
  return res.json();
}

export async function chat(opts: ChatOpts): Promise<{ message: ChatMessage; finishReason: string }> {
  const url = chatUrl();
  const body: Record<string, unknown> = {
    messages: opts.messages,
    max_completion_tokens: opts.maxTokens ?? 1200,
  };
  if (openaiMode()) body.model = config.openai.chatModel;
  if (opts.temperature !== undefined) body.temperature = opts.temperature;
  if (opts.tools?.length) body.tools = opts.tools;
  if (opts.jsonMode) body.response_format = { type: 'json_object' };

  const run = async () => {
    const data = await post(url, body);
    opts.trace?.addUsage({
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      cachedPromptTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    });
    // A 200 with no choices is a real Azure response, not a malformed one: the
    // content filter can return an empty completion this way. Unguarded, the
    // index throws a TypeError inside withRetry, which retries a request that
    // will fail identically and then surfaces as "The model call failed" with
    // nothing a reader or a log can act on. server.ts already translates a
    // content-filter refusal into a sentence; this makes sure it gets one.
    const choice = data.choices?.[0];
    if (!choice?.message) {
      const reason =
        data.choices?.[0]?.finish_reason ??
        (data.prompt_filter_results ? 'content_filter' : 'no choices returned');
      throw new Error(`Azure returned 200 with no completion (${reason})`);
    }
    return {
      message: choice.message as ChatMessage,
      finishReason: choice.finish_reason as string,
    };
  };

  return opts.trace
    ? opts.trace.span(opts.label ?? 'llm', () => withRetry(run))
    : withRetry(run);
}

/**
 * Embeds a batch of texts. Azure accepts an array input, so ingestion batches
 * rather than issuing one request per chunk (~950 requests -> ~10).
 */
export async function embed(texts: string[], trace?: Trace, label = 'embed'): Promise<Float32Array[]> {
  const url = embedUrl();

  const run = async () => {
    const data = await post(url, {
      input: texts,
      dimensions: config.embeddingDims,
      ...(openaiMode() ? { model: config.openai.embeddingModel } : {}),
    });
    trace?.addUsage({ embeddingTokens: data.usage?.total_tokens ?? 0 });
    // Azure does not guarantee response order matches input order; sort by index.
    const sorted = [...data.data].sort((a: any, b: any) => a.index - b.index);
    return sorted.map((d: any) => normalise(Float32Array.from(d.embedding)));
  };

  return trace ? trace.span(label, () => withRetry(run), { n: texts.length }) : withRetry(run);
}

/**
 * L2-normalise once at write time so similarity at query time is a plain dot
 * product instead of a division per comparison.
 */
export function normalise(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= norm;
  return v;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}
