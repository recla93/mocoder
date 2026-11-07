import Anthropic from '@anthropic-ai/sdk';

/** Messaggio neutro rispetto al provider: mocoder parla con Claude e con qualsiasi API OpenAI-compatibile. */
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

/** Errore già spiegato in italiano, da mostrare così com'è all'utente. */
export class AiError extends Error {}

const TRUNCATED = 'La risposta è stata troncata dal limite di lunghezza. Riprova o usa un modello con più spazio.';

// Modelli che accettano il fallback lato server quando un classificatore rifiuta la richiesta.
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
// Modelli vecchi che rifiutano output_config.effort.
const NO_EFFORT = /^claude-(3|haiku-4|sonnet-4-5)/;

function friendly(e: unknown): Error {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('Chiave API Anthropic non valida: usa "mocoder: Configura l\'IA".');
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError(`Accesso negato dal provider: ${e.message}`);
  if (e instanceof Anthropic.NotFoundError) return new AiError('Modello non trovato: controlla l\'impostazione mocoder.ai.model.');
  if (e instanceof Anthropic.RateLimitError) return new AiError('Troppe richieste al provider: riprova tra poco.');
  if (e instanceof Anthropic.BadRequestError) return new AiError(`Richiesta rifiutata dal provider: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) return new AiError('Impossibile raggiungere Anthropic: controlla la connessione.');
  if (e instanceof Anthropic.APIError) return new AiError(`Errore del provider (${e.status}): ${e.message}`);
  return e instanceof Error ? e : new Error(String(e));
}

export function anthropic(opts: { model: string; apiKey?: string; baseURL?: string }): Complete {
  // senza chiave l'SDK usa ANTHROPIC_API_KEY o il profilo di `ant auth login`
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
      if (msg.stop_reason === 'refusal') throw new AiError('Il modello ha rifiutato la richiesta. Riformulala o prova un altro modello.');
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
export function openaiCompatible(opts: { baseUrl: string; model: string; apiKey?: string }): Complete {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  return async req => {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
        // shortcut: niente max_tokens, perché alcuni modelli accettano solo max_completion_tokens; decide il provider
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'system', content: req.system }, ...req.messages],
        }),
      });
    } catch (e) {
      throw new AiError(`Impossibile raggiungere ${opts.baseUrl}: ${(e as Error).message}`);
    }
    if (!res.ok || !res.body) {
      const body = (await res.text()).slice(0, 500);
      if (res.status === 401 || res.status === 403) throw new AiError(`Chiave API non valida per ${opts.baseUrl}.`);
      if (res.status === 404) throw new AiError(`Modello o endpoint non trovato (${opts.model} su ${opts.baseUrl}).`);
      if (res.status === 429) throw new AiError('Troppe richieste al provider: riprova tra poco.');
      throw new AiError(`Errore del provider (${res.status}): ${body}`);
    }

    let text = '';
    let finish: string | undefined;
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let buf = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        const ev = JSON.parse(data);
        if (ev.error) throw new AiError(`Errore del provider: ${ev.error.message ?? JSON.stringify(ev.error)}`);
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
    return { text, inputTokens: usage.prompt_tokens ?? 0, outputTokens: usage.completion_tokens ?? 0 };
  };
}

/**
 * Modelli gratuiti o locali: vanno bene per il tutor, meno per correggere i test di un percorso.
 * shortcut: riconosciuti dal nome e dall'indirizzo (Ollama, ":free" di OpenRouter, "-free", ":cloud"); un modello
 * gratuito con un nome diverso passa per "a pagamento", e l'unica conseguenza è l'ordine dei pulsanti.
 */
export function isFreeModel(s: { provider: string; baseUrl: string; model: string }): boolean {
  if (s.provider === 'anthropic') return false;
  return /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(s.baseUrl) || /(:free|-free|:cloud)$/i.test(s.model);
}

export interface Usage { month: string; tokens: number }

/** Conta i token del mese e blocca le richieste oltre il budget (0 = nessun limite). */
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
      throw new AiError(`Budget mensile di token esaurito (${used.toLocaleString('it-IT')} su ${limit.toLocaleString('it-IT')}). Puoi alzarlo in mocoder.ai.monthlyTokenBudget.`);
    }
    const r = await complete(req);
    await store.set({ month, tokens: used + r.inputTokens + r.outputTokens });
    return r;
  };
}
