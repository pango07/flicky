import type {
  ConversationTurn,
  ScreenCapture,
  ReplyTone,
  OllamaModelInfo,
  OllamaPullProgress,
} from '../../shared/types';
import { buildSystemPrompt } from './prompts';
import { isVisionModel } from '../../shared/vision-models';

const CONNECTION_TIMEOUT_MS = 3_000;

// Appended to the prompt when screenshots exist but aren't sent. The system
// prompt always describes screen0 etc., so without this the model invents
// a screen ("it looks dark", made-up buttons) instead of saying it can't see.
const NO_IMAGE_NOTE =
  '\n\n(Note: no screenshot is attached because the current model does not accept images. ' +
  "Do not describe or guess at the user's screen and do not emit POINT tags. " +
  'If the question needs the screen, tell the user to pick a vision-capable model in Mind settings.)';

export interface OllamaStreamCallbacks {
  onChunk: (text: string) => void;
  onComplete: (fullText: string, usage?: { inputTokens: number; outputTokens: number }) => void;
  onError: (error: Error) => void;
}

export interface OllamaChatOptions {
  replyTone: ReplyTone;
  signal?: AbortSignal;
  /**
   * 'external' = hosted OpenAI-compatible API (Groq, OpenRouter, xAI…).
   * Model ids there don't follow Ollama naming, so we can't tell from the
   * name whether images are supported; we send them and fall back to
   * text-only if the provider rejects the request.
   */
  connectionType?: 'local' | 'external';
}

export interface OllamaTestResult {
  ok: boolean;
  latencyMs: number;
  modelCount?: number;
  error?: string;
}

function authHeaders(bearerToken?: string): Record<string, string> {
  if (bearerToken) return { Authorization: `Bearer ${bearerToken}` };
  return {};
}

// Strip trailing /v1 so callers can safely append /v1/... without doubling.
// e.g. https://api.x.ai/v1 → https://api.x.ai
//      http://localhost:11434 → http://localhost:11434
function normalizeBase(url: string): string {
  return url.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal as AbortSignal, controller.signal])
    : controller.signal;
  try {
    const res = await fetch(url, { ...init, signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

export class OllamaAPI {
  // ── Connection health ───────────────────────────────────────────────

  async testConnection(url: string, bearerToken?: string): Promise<OllamaTestResult> {
    const base = normalizeBase(url);
    const start = Date.now();
    try {
      // Try Ollama-native endpoint first; fall back to OpenAI-compat for external providers.
      let response = await timedFetch(
        `${base}/api/tags`,
        { headers: authHeaders(bearerToken) },
        CONNECTION_TIMEOUT_MS,
      );
      if (response.status === 404) {
        response = await timedFetch(
          `${base}/v1/models`,
          { headers: authHeaders(bearerToken) },
          CONNECTION_TIMEOUT_MS,
        );
      }
      const latencyMs = Date.now() - start;
      if (!response.ok) return { ok: false, latencyMs, error: `HTTP ${response.status}` };
      const data = await response.json() as {
        models?: OllamaModelInfo[];
        data?: { id: string }[];
      };
      const modelCount = data.models?.length ?? data.data?.length ?? 0;
      return { ok: true, latencyMs, modelCount };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, latencyMs, error: msg.includes('abort') ? 'Connection timed out' : msg };
    }
  }

  // ── Model listing ───────────────────────────────────────────────────

  async getModels(url: string, bearerToken?: string): Promise<string[]> {
    const base = normalizeBase(url);
    try {
      let response = await timedFetch(
        `${base}/api/tags`,
        { headers: authHeaders(bearerToken) },
        CONNECTION_TIMEOUT_MS,
      );
      if (response.status === 404) {
        response = await timedFetch(
          `${base}/v1/models`,
          { headers: authHeaders(bearerToken) },
          CONNECTION_TIMEOUT_MS,
        );
        if (!response.ok) return [];
        const data = await response.json() as { data?: { id: string }[] };
        return (data.data ?? []).map((m) => m.id);
      }
      if (!response.ok) return [];
      const data = await response.json() as { models?: OllamaModelInfo[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async getModelDetails(url: string, bearerToken?: string): Promise<OllamaModelInfo[]> {
    const base = normalizeBase(url);
    try {
      let response = await timedFetch(
        `${base}/api/tags`,
        { headers: authHeaders(bearerToken) },
        CONNECTION_TIMEOUT_MS,
      );
      if (response.status === 404) {
        response = await timedFetch(
          `${base}/v1/models`,
          { headers: authHeaders(bearerToken) },
          CONNECTION_TIMEOUT_MS,
        );
        if (!response.ok) return [];
        const data = await response.json() as { data?: { id: string }[] };
        return (data.data ?? []).map((m) => ({ name: m.id }));
      }
      if (!response.ok) return [];
      const data = await response.json() as { models?: OllamaModelInfo[] };
      return data.models ?? [];
    } catch {
      return [];
    }
  }

  // ── Model pull (streaming NDJSON) ───────────────────────────────────

  async pullModel(
    url: string,
    modelTag: string,
    bearerToken: string | undefined,
    onProgress: (p: OllamaPullProgress) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await fetch(`${url}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
      body: JSON.stringify({ name: modelTag, stream: true }),
      signal,
    });
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Pull failed ${response.status}: ${errText}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as OllamaPullProgress;
          onProgress(event);
        } catch { /* skip malformed */ }
      }
    }
  }

  // ── Model delete ────────────────────────────────────────────────────

  async deleteModel(url: string, modelName: string, bearerToken?: string): Promise<void> {
    const response = await timedFetch(
      `${url}/api/delete`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
        body: JSON.stringify({ name: modelName }),
      },
      CONNECTION_TIMEOUT_MS,
    );
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Delete failed ${response.status}: ${errText}`);
    }
  }

  // ── Model create (from modelfile JSON) ──────────────────────────────

  async createModel(
    url: string,
    modelTag: string,
    modelfileJson: string,
    bearerToken?: string,
  ): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(modelfileJson) as Record<string, unknown>;
      body.model = modelTag;
    } catch {
      throw new Error('Invalid JSON in modelfile field.');
    }
    const response = await timedFetch(
      `${url}/api/create`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
        body: JSON.stringify(body),
      },
      30_000,
    );
    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Create failed ${response.status}: ${errText}`);
    }
  }

  // ── Chat (inference) ────────────────────────────────────────────────

  async streamChat(
    prompt: string,
    screenshots: ScreenCapture[],
    history: ConversationTurn[],
    model: string,
    options: OllamaChatOptions,
    callbacks: OllamaStreamCallbacks,
    baseUrl: string,
    bearerToken?: string,
  ): Promise<void> {
    const systemPrompt = buildSystemPrompt(options.replyTone, { hasWebSearch: false });
    const knownVision = isVisionModel(model);
    const hasScreens = screenshots.length > 0;
    const url = `${normalizeBase(baseUrl)}/v1/chat/completions`;

    const buildBody = (withImages: boolean) => {
      const messages: Array<{ role: string; content: unknown }> = [
        { role: 'system', content: systemPrompt },
      ];

      for (const turn of history) {
        messages.push({ role: turn.role, content: turn.content });
      }

      if (withImages) {
        const userContent: Array<Record<string, unknown>> = [];
        for (let i = 0; i < screenshots.length; i++) {
          const sc = screenshots[i];
          userContent.push({
            type: 'text',
            text: `[screen${i}] ${sc.imageWidth}x${sc.imageHeight}px.${sc.isCursorScreen ? ' (active screen)' : ''}`,
          });
          userContent.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${sc.dataBase64}` },
          });
        }
        userContent.push({ type: 'text', text: prompt });
        messages.push({ role: 'user', content: userContent });
      } else {
        messages.push({ role: 'user', content: hasScreens ? prompt + NO_IMAGE_NOTE : prompt });
      }

      return JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
      });
    };

    const send = (withImages: boolean) =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
        body: buildBody(withImages),
        signal: options.signal,
      });

    // Local Ollama: trust the name list. External: always try images.
    const tryImages = hasScreens && (knownVision || options.connectionType === 'external');

    try {
      let response = await send(tryImages);

      // A text-only model behind an OpenAI-compatible API rejects image
      // parts with a 4xx. Retry once without them rather than failing the turn.
      if (!response.ok && tryImages && !knownVision && [400, 413, 415, 422].includes(response.status)) {
        const errText = await response.text();
        console.warn(`[mind] ${model} rejected image input (${response.status}); retrying text-only: ${errText.slice(0, 200)}`);
        response = await send(false);
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Ollama error ${response.status}: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const event = JSON.parse(data);
            const chunk = event.choices?.[0]?.delta?.content;
            if (typeof chunk === 'string' && chunk.length > 0) {
              fullText += chunk;
              callbacks.onChunk(chunk);
            }
            if (event.usage) {
              inputTokens = event.usage.prompt_tokens ?? 0;
              outputTokens = event.usage.completion_tokens ?? 0;
            }
          } catch { /* skip malformed SSE lines */ }
        }
      }

      callbacks.onComplete(fullText, { inputTokens, outputTokens });
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || options.signal?.aborted)) return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
