// free-model-aggregator-02 — one server, two client wires, live free models behind every answer.
//
// Design, in short:
//   - The brief in MAKEFUN_PROMPT_FILE names fourteen free OpenRouter models with the house's
//     ratings and the six prompts in arrival order. Routing is best-first: among the free models
//     that meet a prompt's requirements (JSON mode, tools, vision, minimum context), the highest
//     rating_milli wins, with the model id as a fixed tie-break, so JSON prompts land on the best
//     JSON-capable model instead of the best model overall, which cannot serve them.
//   - Every model is dialled on the gateway's Chat Completions route only, always non-streaming.
//     Client streams are synthesized locally from the complete answer, so their event order is a
//     pure function of the answer and a replay walks the exact same path.
//   - A refusal is never an answer. On a 429 the model is left at once (a rate limit does not heal
//     inside one prompt) and cooled down for the next selections; on a 5xx the first choice gets
//     one retry, then the next candidate is tried. At most four dials serve one prompt. Every
//     refusal is reported on the response in the x-makefun-upstream-failures header, the only
//     place the failover column can see a recovered refusal.
//   - The model field of every answer and every synthesized chunk names the model actually
//     dialled, with the gateway's openrouter/ prefix restored, because the provider's own answer
//     spells it without that prefix and the house scores the model its record shows.
//   - No wall clock and no randomness reach any decision or any byte sent: fixed timestamps in
//     the model lists, count-based cooldowns, and a catalog built once from the brief.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------------------------------------------------------------- the brief

interface ModelRow {
  id: string;
  provider: string;
  displayName: string;
  ratingMilli: number;
  contextLength: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  minContext?: number;
}

interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  requires: Requirement;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
}

/** The index of the closing brace of the JSON object that opens at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON document in the brief prose that carries a schema under this contest's prefix. */
function briefDocuments(text: string): Json[] {
  const docs: Json[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = objectEnd(text, at);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(at, end + 1));
      if (isRecord(value) && typeof value.schema === 'string' && value.schema.startsWith('free-model-aggregator-02/')) docs.push(value);
    } catch {
      // Not a standalone JSON document: keep scanning.
    }
  }
  return docs;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function boolOrNull(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function parseBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { models: [], prompts: [] };
  }
  const docs = briefDocuments(text);
  const modelsDoc = docs.find((d) => Array.isArray(d.models) || Array.isArray(d.ratings));
  const promptsDoc = docs.find((d) => Array.isArray(d.prompts) || Array.isArray(d.manifest));
  const models: ModelRow[] = [];
  if (modelsDoc !== undefined) {
    const rows = (Array.isArray(modelsDoc.models) ? modelsDoc.models : modelsDoc.ratings) as unknown[];
    for (const raw of rows) {
      if (!isRecord(raw)) continue;
      const bare = str(raw.id) !== '' ? str(raw.id) : str(raw.model);
      if (bare === '') continue;
      const provider = str(raw.provider) !== '' ? str(raw.provider) : 'openrouter';
      const id = provider === 'openrouter' && !bare.startsWith('openrouter/') ? `openrouter/${bare}` : bare;
      models.push({
        id,
        provider,
        displayName: str(raw.display_name) !== '' ? str(raw.display_name) : bare,
        ratingMilli: numOrNull(raw.rating_milli) ?? 0,
        contextLength: numOrNull(raw.context_length),
        tools: boolOrNull(raw.tools),
        vision: boolOrNull(raw.vision),
        json: boolOrNull(raw.json),
        free: raw.free !== false,
      });
    }
  }
  const prompts: PromptRow[] = [];
  if (promptsDoc !== undefined) {
    const rows = (Array.isArray(promptsDoc.prompts) ? promptsDoc.prompts : promptsDoc.manifest) as unknown[];
    for (const raw of rows) {
      if (!isRecord(raw) || str(raw.id) === '') continue;
      const req = isRecord(raw.requires) ? raw.requires : {};
      prompts.push({
        id: str(raw.id),
        api: raw.api === 'anthropic' ? 'anthropic' : 'openai',
        stream: raw.stream === true,
        requires: {
          ...(req.tools === true ? { tools: true } : {}),
          ...(req.vision === true ? { vision: true } : {}),
          ...(req.json === true ? { json: true } : {}),
          ...(numOrNull(req.min_context) !== null ? { minContext: numOrNull(req.min_context) as number } : {}),
        },
      });
    }
  }
  return { models, prompts };
}

// ---------------------------------------------------------------- the catalog

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: Array<{ id: string; free: boolean; context_length: number | null }>;
  }>;
}

function buildCatalog(brief: Brief): Catalog {
  const seen = new Set<string>();
  const models: Catalog['providers'][number]['models'] = [];
  for (const m of brief.models) {
    if (!m.free || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({ id: m.id, free: true, context_length: m.contextLength });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      { id: 'openrouter', base_url: 'https://openrouter.ai/api/v1', key_env: 'OPENROUTER_API_KEY', wire: 'openai', models },
    ],
  };
}

// ---------------------------------------------------------------- routing

const MAX_ATTEMPTS_PER_PROMPT = 4;
const MAX_UPSTREAM_TOKENS = 8192;
const DEFAULT_MAX_TOKENS = 1024;

interface ModelHealth {
  refusals: number;
  cooldown: number; // selections this model still sits out, count-based, never time-based
}

const health = new Map<string, ModelHealth>();
function healthOf(id: string): ModelHealth {
  let h = health.get(id);
  if (h === undefined) {
    h = { refusals: 0, cooldown: 0 };
    health.set(id, h);
  }
  return h;
}

function meets(req: Requirement, m: ModelRow): boolean {
  if (req.tools === true && m.tools !== true) return false;
  if (req.vision === true && m.vision !== true) return false;
  if (req.json === true && m.json !== true) return false;
  if (req.minContext !== undefined && (m.contextLength === null || m.contextLength < req.minContext)) return false;
  return true;
}

/**
 * The candidates for one prompt, best first: eligible and not cooling down, by rating then id;
 * cooling-down models follow in the same order, as a last resort before giving up.
 */
function candidatesFor(brief: Brief, req: Requirement): ModelRow[] {
  const eligible = brief.models.filter((m) => m.free && meets(req, m));
  const byRank = (a: ModelRow, b: ModelRow): number =>
    b.ratingMilli - a.ratingMilli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ready = eligible.filter((m) => healthOf(m.id).cooldown === 0).sort(byRank);
  const cooling = eligible.filter((m) => healthOf(m.id).cooldown > 0).sort(byRank);
  return [...ready, ...cooling];
}

/** Age every cooldown by one selection opportunity at the start of a prompt. */
function ageCooldowns(): void {
  for (const h of health.values()) if (h.cooldown > 0) h.cooldown -= 1;
}

// ---------------------------------------------------------------- wire helpers

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function parseArgs(value: unknown): Json {
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: an empty input object.
    }
  }
  return {};
}

function anthropicStopReason(finish: unknown): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function numOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Usage worth reporting: the provider's counts, with the output floored at 1 when text exists. */
function wholeUsage(answer: Json, text: string, toolCalls: unknown[]): { prompt: number; completion: number } {
  const usage = isRecord(answer.usage) ? answer.usage : {};
  let completion = numOrZero(usage.completion_tokens);
  if (completion < 1 && (text !== '' || toolCalls.length > 0)) completion = Math.max(1, Math.ceil(text.length / 4));
  return { prompt: numOrZero(usage.prompt_tokens), completion };
}

interface UpstreamAnswer {
  body: Json;
  text: string;
  toolCalls: Json[];
  finishReason: string;
  usage: { prompt: number; completion: number };
}

function readAnswer(body: Json): UpstreamAnswer {
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const text = typeof message.content === 'string' ? message.content : textOfContent(message.content);
  const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).filter(isRecord);
  return {
    body,
    text,
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : 'stop',
    usage: wholeUsage(body, text, toolCalls),
  };
}

// ---------------------------------------------------------------- request translation

/** Requirements a request body declares on its own, whichever wire it arrived on. */
function requirementsFromBody(wire: 'openai' | 'anthropic', body: Json): Requirement {
  const req: Requirement = {};
  if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  if (wire === 'openai' && isRecord(body.response_format)) {
    if (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema') req.json = true;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    if (!isRecord(raw) || !Array.isArray(raw.content)) continue;
    for (const block of raw.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'image' || block.type === 'image_url') req.vision = true;
    }
  }
  return req;
}

function mergeRequirements(a: Requirement, b: Requirement): Requirement {
  return {
    ...(a.tools === true || b.tools === true ? { tools: true } : {}),
    ...(a.vision === true || b.vision === true ? { vision: true } : {}),
    ...(a.json === true || b.json === true ? { json: true } : {}),
    ...(a.minContext !== undefined || b.minContext !== undefined
      ? { minContext: Math.max(a.minContext ?? 0, b.minContext ?? 0) }
      : {}),
  };
}

function clampTokens(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.min(Math.floor(v), MAX_UPSTREAM_TOKENS);
  return DEFAULT_MAX_TOKENS;
}

/** An OpenAI client body as the upstream body for `model`: the client's fields, capped, never streamed. */
function openAIUpstream(body: Json, model: string): Json {
  const out: Json = { model, messages: Array.isArray(body.messages) ? body.messages : [], stream: false };
  out.max_tokens = clampTokens(body.max_tokens ?? body.max_completion_tokens);
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop = body.stop;
  if (Array.isArray(body.tools) && body.tools.length > 0) out.tools = body.tools;
  if (body.tool_choice !== undefined) out.tool_choice = body.tool_choice;
  if (isRecord(body.response_format)) out.response_format = body.response_format;
  return out;
}

/** An Anthropic Messages body as a Chat Completions body for `model`. */
function anthropicUpstream(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOfContent(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    if (typeof raw.content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content: raw.content });
      continue;
    }
    if (!Array.isArray(raw.content)) continue;
    if (assistant) {
      const calls: Json[] = [];
      for (const block of raw.content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        calls.push({
          id: typeof block.id === 'string' ? block.id : '',
          type: 'function',
          function: {
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOfContent(raw.content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(calls.length > 0 ? { tool_calls: calls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of raw.content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
          content: textOfContent(block.content) !== '' ? textOfContent(block.content) : typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? ''),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ type: 'text', text: block.text });
      else if (block.type === 'image' && isRecord(block.source)) {
        const source = block.source;
        if (source.type === 'base64' && typeof source.data === 'string') {
          const media = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } });
        } else if (source.type === 'url' && typeof source.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: source.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }
  const out: Json = { model, messages, stream: false, max_tokens: clampTokens(body.max_tokens) };
  if (typeof body.temperature === 'number') out.temperature = body.temperature;
  if (typeof body.top_p === 'number') out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: typeof raw.description === 'string' ? raw.description : '',
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  const choice = body.tool_choice;
  if (isRecord(choice)) {
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  return out;
}

// ---------------------------------------------------------------- the dial

interface FailureRow {
  status: number;
  code: string;
  model: string | null;
}

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const GATEWAY_BASE = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
const GATEWAY_KEY = process.env.OPENAI_API_KEY ?? '';

function gatewayUrl(): string {
  if (GATEWAY_BASE === '') return '';
  return GATEWAY_BASE.endsWith('/v1') ? `${GATEWAY_BASE}/chat/completions` : `${GATEWAY_BASE}/v1/chat/completions`;
}

function failureCode(status: number, text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      if (typeof parsed.error.code === 'string' && parsed.error.code !== '') return parsed.error.code;
      if (typeof parsed.error.type === 'string' && parsed.error.type !== '') return parsed.error.type;
    }
  } catch {
    // Not JSON: fall through to the status slug.
  }
  return `http_${status}`;
}

interface DialOutcome {
  answer: UpstreamAnswer | null;
  servedBy: string | null;
  failures: FailureRow[];
}

/**
 * Serve one upstream body template through the candidate list. `makeBody` renders the body for a
 * chosen model, so the Anthropic translation names the model it dials. Deterministic in the
 * gateway's answers: the same refusals walk the same candidates in the same order.
 */
async function dialWithFailover(
  brief: Brief,
  req: Requirement,
  makeBody: (model: string) => Json,
): Promise<DialOutcome> {
  const failures: FailureRow[] = [];
  const candidates = candidatesFor(brief, req);
  let attempts = 0;
  for (const candidate of candidates) {
    if (attempts >= MAX_ATTEMPTS_PER_PROMPT) break;
    let retried5xx = false;
    for (;;) {
      if (attempts >= MAX_ATTEMPTS_PER_PROMPT) break;
      attempts += 1;
      let response: Response;
      try {
        response = await fetch(gatewayUrl(), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
          body: JSON.stringify(makeBody(candidate.id)),
        });
      } catch (err) {
        failures.push({ status: 0, code: 'network_error', model: candidate.id });
        healthOf(candidate.id).refusals += 1;
        break;
      }
      if (response.ok) {
        const parsed: unknown = await response.json().catch(() => null);
        if (isRecord(parsed)) {
          healthOf(candidate.id).cooldown = 0;
          return { answer: readAnswer(parsed), servedBy: candidate.id, failures };
        }
        failures.push({ status: response.status, code: 'invalid_upstream_body', model: candidate.id });
        break;
      }
      const text = await response.text().catch(() => '');
      failures.push({ status: response.status, code: failureCode(response.status, text), model: candidate.id });
      const h = healthOf(candidate.id);
      h.refusals += 1;
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        // A refusal that cannot heal inside one trial: a key the gateway refuses, a model gated
        // to other harnesses (the brief's best-rated model answers a plain API call with exactly
        // this 403), or a model the provider no longer knows. Sit it out for the whole trial
        // instead of spending one call per prompt rediscovering it.
        h.cooldown = Number.MAX_SAFE_INTEGER;
        break;
      }
      if (response.status === 429) {
        h.cooldown = Math.max(h.cooldown, 2);
        break; // A rate limit does not heal inside one prompt.
      }
      if (response.status >= 500 && !retried5xx) {
        retried5xx = true;
        h.cooldown = Math.max(h.cooldown, 4);
        continue; // One retry for a server error, then move on.
      }
      if (response.status >= 500) h.cooldown = Math.max(h.cooldown, 4);
      break;
    }
  }
  return { answer: null, servedBy: null, failures };
}

// ---------------------------------------------------------------- responses

function trailHeader(failures: FailureRow[]): Record<string, string> {
  if (failures.length === 0) return {};
  return { 'x-makefun-upstream-failures': JSON.stringify(failures.slice(0, 8)) };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function openAIErrorBody(message: string, type: string): Json {
  return { error: { message, type, code: null } };
}
function anthropicErrorBody(type: string, message: string): Json {
  return { type: 'error', error: { type, message } };
}

function sse(data: unknown, event: string | null = null): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/** Split a text into fixed-size pieces, so synthesized streams are a pure function of the text. */
function pieces(text: string, size = 24): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function openAIStreamFrames(answer: UpstreamAnswer, model: string, includeUsage: boolean): string[] {
  const frames: string[] = [];
  const base = { id: answer.body.id ?? 'chatcmpl-aggregate', object: 'chat.completion.chunk', created: 1767225600, model };
  frames.push(sse({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
  for (const piece of pieces(answer.text)) {
    frames.push(sse({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }));
  }
  answer.toolCalls.forEach((call, index) => {
    const fn = isRecord(call.function) ? call.function : {};
    frames.push(
      sse({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index,
                  id: typeof call.id === 'string' ? call.id : `call_${index}`,
                  type: 'function',
                  function: {
                    name: typeof fn.name === 'string' ? fn.name : '',
                    arguments: typeof fn.arguments === 'string' ? fn.arguments : '',
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    );
  });
  frames.push(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: answer.finishReason }] }));
  if (includeUsage) {
    frames.push(
      sse({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: answer.usage.prompt,
          completion_tokens: answer.usage.completion,
          total_tokens: answer.usage.prompt + answer.usage.completion,
        },
      }),
    );
  }
  frames.push('data: [DONE]\n\n');
  return frames;
}

function anthropicMessage(answer: UpstreamAnswer, model: string): Json {
  const content: Json[] = [];
  if (answer.text !== '') content.push({ type: 'text', text: answer.text });
  for (const call of answer.toolCalls) {
    const fn = isRecord(call.function) ? call.function : {};
    content.push({
      type: 'tool_use',
      id: typeof call.id === 'string' && call.id !== '' ? call.id : 'toolu_aggregate',
      name: typeof fn.name === 'string' ? fn.name : '',
      input: parseArgs(fn.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${typeof answer.body.id === 'string' ? answer.body.id : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: anthropicStopReason(answer.finishReason),
    stop_sequence: null,
    usage: { input_tokens: answer.usage.prompt, output_tokens: answer.usage.completion },
  };
}

function anthropicStreamFrames(answer: UpstreamAnswer, model: string): string[] {
  const frames: string[] = [];
  frames.push(
    sse(
      {
        type: 'message_start',
        message: {
          id: `msg_${typeof answer.body.id === 'string' ? answer.body.id : 'aggregate'}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: answer.usage.prompt, output_tokens: 0 },
        },
      },
      'message_start',
    ),
  );
  let index = 0;
  if (answer.text !== '' || answer.toolCalls.length === 0) {
    frames.push(sse({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, 'content_block_start'));
    for (const piece of pieces(answer.text)) {
      frames.push(sse({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }, 'content_block_delta'));
    }
    frames.push(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
    index += 1;
  }
  for (const call of answer.toolCalls) {
    const fn = isRecord(call.function) ? call.function : {};
    frames.push(
      sse(
        {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: typeof call.id === 'string' && call.id !== '' ? call.id : `toolu_${index}`,
            name: typeof fn.name === 'string' ? fn.name : '',
            input: {},
          },
        },
        'content_block_start',
      ),
    );
    const args = typeof fn.arguments === 'string' ? fn.arguments : '';
    if (args !== '') {
      frames.push(sse({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } }, 'content_block_delta'));
    }
    frames.push(sse({ type: 'content_block_stop', index }, 'content_block_stop'));
    index += 1;
  }
  frames.push(
    sse(
      {
        type: 'message_delta',
        delta: { stop_reason: anthropicStopReason(answer.finishReason), stop_sequence: null },
        usage: { output_tokens: answer.usage.completion },
      },
      'message_delta',
    ),
  );
  frames.push(sse({ type: 'message_stop' }, 'message_stop'));
  return frames;
}

// ---------------------------------------------------------------- the server

const PROMPT_FILE = process.env.MAKEFUN_PROMPT_FILE ?? '';
const brief = parseBrief(PROMPT_FILE);
const catalog = buildCatalog(brief);
let manifestIndex = 0;

function log(message: string): void {
  process.stderr.write(`aggregator-02: ${message}\n`);
}

/** The requirements of the next arriving prompt: its manifest row merged with what its body declares. */
function requirementsFor(wire: 'openai' | 'anthropic', body: Json): Requirement {
  const row = brief.prompts[manifestIndex];
  manifestIndex += 1;
  ageCooldowns();
  return mergeRequirements(row !== undefined ? row.requires : {}, requirementsFromBody(wire, body));
}

async function readJsonBody(req: IncomingMessage): Promise<Json | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > 8 * 1024 * 1024) return null;
    chunks.push(buffer);
  }
  if (chunks.length === 0) return null;
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function sendStream(res: ServerResponse, frames: string[], extra: Record<string, string>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
  for (const frame of frames) res.write(frame);
  res.end();
}

async function handleChat(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) return sendJson(res, 400, openAIErrorBody('the request body is not one JSON object', 'invalid_request_error'));
  const reqs = requirementsFor('openai', body);
  const outcome = await dialWithFailover(brief, reqs, (model) => openAIUpstream(body, model));
  const trail = trailHeader(outcome.failures);
  if (outcome.answer === null || outcome.servedBy === null) {
    return sendJson(res, 502, openAIErrorBody('every free model refused this request', 'upstream_error'), trail);
  }
  if (body.stream === true) {
    const includeUsage = isRecord(body.stream_options) && body.stream_options.include_usage === true;
    return sendStream(res, openAIStreamFrames(outcome.answer, outcome.servedBy, includeUsage), trail);
  }
  const answerBody: Json = { ...outcome.answer.body, model: outcome.servedBy };
  const usage = isRecord(answerBody.usage) ? answerBody.usage : {};
  answerBody.usage = {
    ...usage,
    prompt_tokens: outcome.answer.usage.prompt,
    completion_tokens: outcome.answer.usage.completion,
    total_tokens: outcome.answer.usage.prompt + outcome.answer.usage.completion,
  };
  return sendJson(res, 200, answerBody, trail);
}

async function handleMessages(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) return sendJson(res, 400, anthropicErrorBody('invalid_request_error', 'the request body is not one JSON object'));
  const reqs = requirementsFor('anthropic', body);
  const outcome = await dialWithFailover(brief, reqs, (model) => anthropicUpstream(body, model));
  const trail = trailHeader(outcome.failures);
  if (outcome.answer === null || outcome.servedBy === null) {
    return sendJson(res, 502, anthropicErrorBody('api_error', 'every free model refused this request'), trail);
  }
  if (body.stream === true) return sendStream(res, anthropicStreamFrames(outcome.answer, outcome.servedBy), trail);
  return sendJson(res, 200, anthropicMessage(outcome.answer, outcome.servedBy), trail);
}

function handleModels(req: IncomingMessage, res: ServerResponse): void {
  const free = brief.models.filter((m) => m.free);
  if (typeof req.headers['x-api-key'] === 'string') {
    return sendJson(res, 200, {
      data: free.map((m) => ({ type: 'model', id: m.id, display_name: m.displayName, created_at: '2026-01-01T00:00:00Z' })),
      has_more: false,
    });
  }
  return sendJson(res, 200, {
    object: 'list',
    data: free.map((m) => ({ id: m.id, object: 'model', created: 1767225600, owned_by: m.provider })),
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://entry');
  if (req.method === 'GET' && url.pathname === '/v1/models') return handleModels(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return handleChat(req, res);
  if (req.method === 'POST' && url.pathname === '/v1/messages') return handleMessages(req, res);
  return sendJson(res, 404, openAIErrorBody(`no route ${req.method ?? ''} ${url.pathname}`, 'not_found'));
}

async function register(port: number): Promise<void> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const reply: unknown = await res.json().catch(() => null);
        if (isRecord(reply) && typeof reply.requests === 'number') log(`registered: ${reply.requests} prompts`);
        return;
      }
      lastError = new Error(`register answered HTTP ${res.status}`);
    } catch (err) {
      lastError = err as Error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw lastError ?? new Error('register never answered');
}

function pollWork(server: Server): void {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const res = await fetch(`${ENV_URL}/work`, { signal: AbortSignal.timeout(2000) });
        if (res.status === 200) {
          const work: unknown = await res.json().catch(() => null);
          if (isRecord(work) && work.done === true) {
            clearInterval(timer);
            server.close();
            process.exit(0);
          }
        }
      } catch {
        // The env is not reachable yet: poll again on the next tick.
      } finally {
        inFlight = false;
      }
    })();
  }, 100);
}

async function start(): Promise<void> {
  if (process.argv.includes('--list')) {
    const text = `${JSON.stringify(catalog)}\n`;
    await new Promise<void>((resolve) => process.stdout.write(text, () => resolve()));
    process.exit(0);
  }
  if (ENV_URL === '') throw new Error('MAKEFUN_ENV_URL is not set');
  if (gatewayUrl() === '') throw new Error('OPENAI_BASE_URL is not set');
  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log((err as Error).stack ?? String(err));
      if (!res.headersSent) sendJson(res, 500, openAIErrorBody('the server failed to answer', 'internal_error'));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  if (address.port === 8080) throw new Error('the OS picked the env port 8080');
  log(`listening on 0.0.0.0:${address.port} with ${brief.models.filter((m) => m.free).length} free models`);
  await register(address.port);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  pollWork(server);
}

try {
  await start();
} catch (err) {
  log((err as Error).stack ?? String(err));
  process.exit(1);
}
