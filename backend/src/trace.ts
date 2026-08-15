import { randomUUID } from 'node:crypto';
import { config } from './config.js';

/**
 * Minimal tracing primitive.
 *
 * Every request gets a Trace. Every meaningful stage (embed, dense search,
 * sparse search, fuse, llm call) is recorded with duration and, where relevant,
 * token usage. This is deliberately a few dozen lines rather than OpenTelemetry:
 * see DECISIONS.md D-10.
 */

export interface Span {
  name: string;
  ms: number;
  meta?: Record<string, unknown>;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  embeddingTokens: number;
  /**
   * Prompt tokens served from the provider's prefix cache. Tracked because the
   * cost estimate is wrong without it: cached input is billed at a discount, so
   * counting every prompt token at full rate over-states cost. It is also the
   * signal that tells you whether prompt structure is cache-friendly. A large
   * constant system prompt placed first should produce hits on later turns.
   */
  cachedPromptTokens: number;
}

export class Trace {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly spans: Span[] = [];
  readonly usage: Usage = { promptTokens: 0, completionTokens: 0, embeddingTokens: 0, cachedPromptTokens: 0 };

  async span<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, ms: Math.round(performance.now() - t0), meta });
    }
  }

  addUsage(u: Partial<Usage>) {
    this.usage.promptTokens += u.promptTokens ?? 0;
    this.usage.completionTokens += u.completionTokens ?? 0;
    this.usage.embeddingTokens += u.embeddingTokens ?? 0;
    this.usage.cachedPromptTokens += u.cachedPromptTokens ?? 0;
  }

  /** Estimated USD. Rates are assumptions, see DECISIONS.md D-11. */
  get costUsd(): number {
    const p = config.pricing;
    // Cached prompt tokens are billed at a discount; charging them at full rate
    // would overstate cost on multi-turn conversations.
    const uncached = Math.max(0, this.usage.promptTokens - this.usage.cachedPromptTokens);
    return (
      (uncached / 1e6) * p.llmInputPerM +
      (this.usage.cachedPromptTokens / 1e6) * p.llmInputPerM * p.cachedInputDiscount +
      (this.usage.completionTokens / 1e6) * p.llmOutputPerM +
      (this.usage.embeddingTokens / 1e6) * p.embeddingPerM
    );
  }

  summary() {
    return {
      traceId: this.id,
      totalMs: Date.now() - this.startedAt,
      spans: this.spans,
      usage: this.usage,
      estimatedCostUsd: Number(this.costUsd.toFixed(6)),
    };
  }

  /** One JSON line per request, greppable, and what you would ship to a log sink. */
  log() {
    console.log(JSON.stringify({ type: 'trace', ...this.summary() }));
  }
}
