import Anthropic from '@anthropic-ai/sdk';

/** Provider-neutral message: mocoder talks to Claude and to any OpenAI-compatible API. */
export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export type Effort = 'low' | 'medium' | 'high';
export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  effort: Effort;
  onText?: (delta: string) => void;
}
export interface ChatResult { text: string; inputTokens: number; outputTokens: number }
export type Complete = (req: ChatRequest) => Promise<ChatResult>;

/** Error already explained to the user, to be shown as is. */
export class AiError extends Error {
  unavailable: boolean;
  constructor(message: string, unavailable = false) { super(message); this.unavailable = unavailable; }
}

/** Silence after which a provider is considered stuck. Thinking models can pause, so not too short. */
const IDLE_MS = 120_000;

const TRUNCATED ='The response was truncated by the length limit. Try again or use a model with more room.';

// Models that accept server-side fallback when a classifier refuses the request.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Old models that reject output_config.effort.
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5)/;

function friendly(e: unknown): Error {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('Invalid Anthropic API key: use "mocoder: Configure AI".', true);
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError(`Access denied by the provider: ${e.message}`, true);
  if (e instanceof Anthropic.NotFoundError) return new AiError('Model not found: check the mocoder.ai.model setting.', true);
  if (e instanceof Anthropic.RateLimitError) return new AiError('Too many requests to the provider: try again shortly.', true);
  if (e instanceof Anthropic.BadRequestError) return new AiError(`Request rejected by the provider: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new AiError('Cannot reach Anthropic: check your connection.', true);
  if (e instanceof Anthropic.APIError) return new AiError(`Provider error (${e.status}): ${e.message}`, (e.status ?? 0) >= 500);
  return e instanceof Error ? e : new Error(String(e));
}

export function anthropic(opts: { model: string; apiKey?: string; baseURL?: string }): Complete {
  // without a key the SDK uses ANTHROPIC_API_KEY or the `ant auth login` profile
  const client = new Anthropic({ apiKey: opts.apiKey || undefined, baseURL: opts.baseURL || undefined });
  return async req => {
    try {
      const stream = client.beta.messages.stream({
        model: opts.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: req.messages,
        ...(NO_EFFORT.test(opts.model) ? {} : { output_config: { effort: req.effort } }),
        ...(FALLBACK_MODELS.has(opts.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      });
      if (req.onText) stream.on('text', req.onText);
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new AiError('The model refused the request. Rephrase it or try another model.');
      if (msg.stop_reason === 'max_tokens') throw new AiError(TRUNCATED);
      const text = msg.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
      const u = msg.usage;
      return {
        text,
        inputTokens: u.input_tokens + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
        outputTokens: u.output_tokens,
      };
    } catch (e) {
      throw friendly(e);
    }
  };
}

/** OpenAI, OpenRouter, Groq, LM Studio, Ollama (`http://localhost:11434/v1`)… */
export function openaiCompatible(opts: { baseUrl: string; model: string; apiKey?: string; idleMs?: number }): Complete {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  // no total limit (a Planner answer takes minutes), only silence: a stuck provider must not freeze the panel
  const idleMs = opts.idleMs ?? IDLE_MS;
  return async req => {
    const abort = new AbortController();
    let timer = setTimeout(() => abort.abort(), idleMs);
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => abort.abort(), idleMs); };
    const stalled = () => new AiError(`The provider stopped answering (no data for ${idleMs / 1000}s). Try again, or switch provider.`, true);
    try {
      return await stream(req, abort.signal, alive);
    } catch (e) {
      throw abort.signal.aborted ? stalled() : e;
    } finally {
      clearTimeout(timer);
    }
  };

  async function stream(req: ChatRequest, signal: AbortSignal, alive: () => void): Promise<ChatResult> {
    let res: Response;
    try {
      res = await fetch(url, {
        signal,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        // shortcut: no max_tokens, because some models only accept max_completion_tokens; the provider decides
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'system', content: req.system }, ...req.messages],
        }),
      });
    } catch (e) {
      throw new AiError(`Cannot reach ${opts.baseUrl}: ${(e as Error).message}`, true);
    }
    if (!res.ok || !res.body) {
      const body = (await res.text()).slice(0, 500);
      // the provider's own reason tells per-minute quota from daily cap or data-policy problems
      let reason = '';
      try { reason = String(JSON.parse(body).error?.message ?? '').slice(0, 200); } catch { /* not JSON */ }
      const why = reason ? ` Provider says: "${reason}"` : '';
      if (res.status === 401 || res.status === 403) throw new AiError(`Invalid API key for ${opts.baseUrl}. Run "mocoder: Configure AI" again and re-enter it.`, true);
      if (res.status === 402) throw new AiError('Credit exhausted on this provider: top up the account or switch route with "mocoder: Configure AI".', true);
      if (res.status === 404) throw new AiError(`Model or endpoint not found (${opts.model} on ${opts.baseUrl}): check mocoder.ai.model and the address.${why}`, true);
      if (res.status === 429) throw new AiError(`Too many requests: the free plan has a quota. Wait a minute and try again, or connect a pay-as-you-go API with "mocoder: Configure AI".${why}`, true);
      throw new AiError(`Provider error (${res.status}): ${body}`, res.status >= 500);
    }

    let text = '';
    let finish: string | undefined;
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      alive();
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const ev = JSON.parse(data);
        if (ev.error) throw new AiError(`Provider error: ${ev.error.message ?? JSON.stringify(ev.error)}`, true);
        const delta: string | undefined = ev.choices?.[0]?.delta?.content;
        if (delta) {
          text += delta;
          req.onText?.(delta);
        }
        finish = ev.choices?.[0]?.finish_reason ?? finish;
        if (ev.usage) usage = ev.usage;
      }
    }
    if (finish === 'length') throw new AiError(TRUNCATED);
    // an endpoint that ignores stream:true replies with JSON: without this check the tutor would show an empty response
    if (!text.trim()) throw new AiError('The provider replied with no text: it may not support streaming. Try another model or provider.', true);
    return { text, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
  }
}

/**
 * Free or local models: fine for the tutor, less so for fixing the tests of a path.
 * shortcut: recognized by name and address (Ollama, OpenRouter's ":free", "-free", ":cloud"); a free
 * model with a different name is treated as "paid", and the only consequence is the order of the buttons.
 */
export function isFreeModel(s: { provider: string; baseUrl: string; model: string }): boolean {
  if (s.provider === 'anthropic') return false;
  return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(s.baseUrl) || /(:free|-free|:cloud)$/i.test(s.model);
}

export interface Usage { month: string; tokens: number }

/** Counts the month's tokens and blocks requests over the budget (0 = no limit). */
export function withBudget(
  complete: Complete,
  store: { get(): Usage | undefined; set(u: Usage): unknown },
  budget: () => number,
  now = () => new Date(),
): Complete {
  return async req => {
    const month = now().toISOString().slice(0, 7);
    const prev = store.get();
    const used = prev?.month === month ? prev.tokens : 0;
    const limit = budget();
    if (limit > 0 && used >= limit) {
      throw new AiError(`Monthly token budget exhausted (${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')}). You can raise it in mocoder.ai.monthlyTokenBudget.`);
    }
    const r = await complete(req);
    await store.set({ month, tokens: used + r.inputTokens + r.outputTokens });
    return r;
  };
}
