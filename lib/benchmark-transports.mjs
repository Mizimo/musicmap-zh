import { access, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 300_000;
const CODEX_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const ADAPTER_SUFFIX = 'dist/api/openai-codex-responses.js';

export class BenchmarkTransportError extends Error {
  constructor(provider, code, status = null) {
    super(`${provider} benchmark request failed (${code}${status ? `; HTTP ${status}` : ''}).`);
    this.name = 'BenchmarkTransportError';
    this.provider = provider;
    this.code = code;
    this.status = status;
    this.httpStatus = status;
  }
}

function fail(provider, code, status) {
  return new BenchmarkTransportError(provider, code, status);
}

function validRequest(provider, model, effort, systemPrompt, prompt, efforts) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(model)
    || !efforts.includes(effort) || typeof systemPrompt !== 'string' || !systemPrompt.trim()
    || typeof prompt !== 'string' || !prompt.trim()) {
    throw fail(provider, 'INVALID_CONFIGURATION');
  }
}

const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,160}$/.test(value) ? value : null;

function normalizeUsage(usage, provider) {
  const codex = provider === 'codex';
  const inputTokens = count(codex ? usage?.input_tokens : usage?.prompt_tokens);
  const cachedInputTokens = count(codex ? usage?.input_tokens_details?.cached_tokens : usage?.prompt_cache_hit_tokens);
  const cacheWriteInputTokens = codex ? count(usage?.input_tokens_details?.cache_write_tokens) : null;
  const reportedMiss = codex ? null : count(usage?.prompt_cache_miss_tokens);
  return {
    inputTokens,
    // Missing breakdowns stay unknown; they are not measured zeroes.
    uncachedInputTokens: reportedMiss ?? (inputTokens !== null && cachedInputTokens !== null
      ? Math.max(0, inputTokens - cachedInputTokens - (cacheWriteInputTokens ?? 0)) : null),
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: count(codex ? usage?.output_tokens : usage?.completion_tokens),
    reasoningTokens: count(codex ? usage?.output_tokens_details?.reasoning_tokens : usage?.completion_tokens_details?.reasoning_tokens),
    totalTokens: count(usage?.total_tokens),
  };
}

function timings(startedAt, started) {
  return { startedAt, finishedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started) };
}

// Provider messages may echo request data. Retain only known diagnostic identifiers.
const UPSTREAM_CODES = new Set([
  'INVALID_REQUEST_ERROR', 'INVALID_REQUEST', 'INVALID_API_KEY', 'AUTHENTICATION_ERROR',
  'PERMISSION_DENIED', 'RATE_LIMIT_EXCEEDED', 'RATE_LIMIT_ERROR', 'INSUFFICIENT_QUOTA',
  'INSUFFICIENT_BALANCE', 'MODEL_NOT_FOUND', 'CONTEXT_LENGTH_EXCEEDED', 'SERVER_ERROR',
  'INTERNAL_SERVER_ERROR', 'INTERNAL_ERROR', 'SERVICE_UNAVAILABLE', 'API_ERROR',
  'TIMEOUT', 'REQUEST_TIMEOUT', 'GATEWAY_TIMEOUT', 'INSUFFICIENT_SYSTEM_RESOURCE', 'ABORTED',
]);

function upstreamDiagnostic(payload) {
  const upstream = payload?.error;
  if (!upstream || typeof upstream !== 'object') return {};
  const code = typeof (upstream.code ?? upstream.type) === 'string'
    ? String(upstream.code ?? upstream.type).toUpperCase() : '';
  const status = upstream.status ?? upstream.status_code;
  return {
    upstreamCode: UPSTREAM_CODES.has(code) ? code : 'UNKNOWN_UPSTREAM_ERROR',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {}),
  };
}

/** Parse both final-choice usage and usage-only chunks; never retain reasoning deltas. */
async function readDeepseekStream(response) {
  const payload = { choices: [{ finish_reason: null, message: { content: '' } }], usage: null,
    streamComplete: false, streamInterrupted: false, upstreamDiagnostic: {} };
  if (!response.body) return payload;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.trim()) buffer += '\n\n';
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (!data.trim()) continue;
        if (data.trim() === '[DONE]') {
          payload.streamComplete = true;
          void reader.cancel().catch(() => {});
          return payload;
        }
        const chunk = JSON.parse(data);
        payload.upstreamDiagnostic = { ...payload.upstreamDiagnostic, ...upstreamDiagnostic(chunk) };
        for (const field of ['model', 'reasoning_effort', 'service_tier']) {
          if (label(chunk[field])) payload[field] = label(chunk[field]);
        }
        if (label(chunk.reasoning?.effort)) payload.reasoning_effort = label(chunk.reasoning.effort);
        if (chunk.usage && typeof chunk.usage === 'object') payload.usage = chunk.usage;
        const choice = chunk.choices?.find((item) => item.index === 0) ?? chunk.choices?.[0];
        if (typeof choice?.delta?.content === 'string') payload.choices[0].message.content += choice.delta.content;
        if (label(choice?.finish_reason)) payload.choices[0].finish_reason = label(choice.finish_reason);
        if (payload.choices[0].message.content.length > 16_000_000) throw new Error();
      }
      if (buffer.length > 16_000_000) throw new Error();
      if (done) break;
    }
  } catch {
    // Any measured usage remains available for cost accounting after an interrupted stream.
    payload.streamInterrupted = true;
    void reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
  return payload;
}

/** One billable Chat Completions request. No retries, agent tools, or persisted reasoning. */
export async function deepseekRequest({
  model, effort, systemPrompt, prompt, key, baseUrl = 'https://api.deepseek.com',
  fetchImpl = globalThis.fetch, stream = false, timeoutMs = TIMEOUT_MS,
}) {
  validRequest('deepseek', model, effort, systemPrompt, prompt, ['low', 'high', 'max']);
  if (typeof stream !== 'boolean' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
    throw fail('deepseek', 'INVALID_CONFIGURATION');
  }
  if (typeof key !== 'string' || !key.trim()) throw fail('deepseek', 'AUTH_MISSING');
  let endpoint;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error();
    endpoint = `${base.href.replace(/\/+$/, '')}/chat/completions`;
  } catch {
    throw fail('deepseek', 'INVALID_CONFIGURATION');
  }
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  let httpStatus = null;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
        thinking: { type: 'enabled' }, reasoning_effort: effort,
        max_tokens: 16000, stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      }),
    });
    httpStatus = response.status;
    const streamingResponse = stream && response.ok && !response.headers.get('content-type')?.includes('application/json');
    const payload = streamingResponse ? await readDeepseekStream(response) : await response.json().catch(() => null);
    const diagnostic = { ...upstreamDiagnostic(payload), ...payload?.upstreamDiagnostic };
    if (!response.ok && !payload?.usage) throw Object.assign(fail('deepseek', 'HTTP_ERROR', httpStatus), diagnostic);
    const choice = payload?.choices?.[0];
    if (!payload?.usage || typeof payload.usage !== 'object') {
      throw Object.assign(fail('deepseek', signal.aborted ? 'TIMEOUT' : 'USAGE_MISSING', httpStatus), diagnostic);
    }
    const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const interrupted = streamingResponse && (!payload.streamComplete || payload.streamInterrupted);
    const complete = response.ok && !diagnostic.upstreamCode && !interrupted && choice?.finish_reason === 'stop' && Boolean(text.trim());
    const status = complete ? 'completed' : (!response.ok || diagnostic.upstreamCode ? 'failed' : interrupted || choice?.finish_reason !== 'stop' ? 'incomplete' : 'failed');
    return {
      text,
      rawUsage: payload.usage,
      normalizedUsage: normalizeUsage(payload.usage, 'deepseek'),
      returnedModel: label(payload.model),
      returnedEffort: label(payload.reasoning_effort ?? payload.reasoning?.effort),
      serviceTier: label(payload.service_tier),
      status, httpStatus, finishReason: label(choice?.finish_reason),
      transport: streamingResponse ? 'sse' : 'json',
      streamTransport: Boolean(streamingResponse),
      ...diagnostic,
      ...(complete ? {} : { errorCode: !response.ok ? 'HTTP_ERROR' : diagnostic.upstreamCode ? 'UPSTREAM_ERROR' : interrupted ? 'STREAM_INTERRUPTED' : text.trim() ? 'INCOMPLETE_RESPONSE' : 'EMPTY_RESPONSE' }),
      ...timings(startedAt, started),
    };
  } catch (error) {
    if (error instanceof BenchmarkTransportError) throw error;
    throw fail('deepseek', signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED', httpStatus);
  }
}

async function findCodexAdapter(explicitPath) {
  const override = explicitPath || process.env.MUSICMAP_CODEX_ADAPTER;
  if (override) {
    const candidate = resolve(override);
    for (const file of [candidate, join(candidate, ADAPTER_SUFFIX)]) {
      try {
        if (file.endsWith('.js') || file.endsWith('.mjs')) { await access(file); return file; }
      } catch { /* Try package directory next. */ }
    }
    throw fail('codex', 'ADAPTER_NOT_FOUND');
  }
  try {
    return createRequire(import.meta.url).resolve('@earendil-works/pi-ai/api/openai-codex-responses');
  } catch { /* DSH may install pi-ai in the npm execution cache. */ }
  const cache = join(process.env.npm_config_cache || join(homedir(), '.npm'), '_npx');
  let directories = [];
  try { directories = await readdir(cache, { withFileTypes: true }); } catch { /* Missing cache. */ }
  for (const directory of directories.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(cache, directory.name, 'node_modules/@earendil-works/pi-ai', ADAPTER_SUFFIX);
    try { await access(file); return file; } catch { /* Continue discovery. */ }
  }
  throw fail('codex', 'ADAPTER_NOT_FOUND');
}

async function readCodexAccess(authPath) {
  try {
    const auth = JSON.parse(await readFile(authPath || process.env.CODEX_AUTH_PATH || join(homedir(), '.codex/auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    if (typeof token !== 'string' || !token) throw fail('codex', 'AUTH_MISSING');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    if (typeof claims.exp === 'number' && claims.exp * 1000 <= Date.now()) throw fail('codex', 'AUTH_EXPIRED');
    return token;
  } catch (error) {
    if (error instanceof BenchmarkTransportError) throw error;
    throw fail('codex', 'AUTH_UNREADABLE');
  }
}

/** Inspect terminal SSE metadata while discarding all output/reasoning event bodies. */
async function readTerminalMetadata(response) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let terminal = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done && buffer.trim()) buffer += '\n\n';
      let separator;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (['response.completed', 'response.done', 'response.incomplete', 'response.failed'].includes(event.type)) {
          const result = event.response || {};
          terminal = {
            rawUsage: result.usage ?? null,
            returnedModel: label(result.model),
            returnedEffort: label(result.reasoning?.effort),
            serviceTier: label(result.service_tier),
            status: label(result.status),
          };
          // No need to keep collecting reasoning/output events after the terminal response.
          void reader.cancel().catch(() => {});
          return terminal;
        }
      }
      if (buffer.length > 16_000_000) throw fail('codex', 'SSE_EVENT_TOO_LARGE');
      if (done) break;
    }
    return terminal;
  } finally {
    reader.releaseLock();
  }
}

/** Use locally authenticated Codex with an installed pi-ai adapter, without CLI agent overhead. */
export async function codexRequest({
  model, effort, systemPrompt, prompt, authPath, adapterPath, fetchImpl = globalThis.fetch,
}) {
  validRequest('codex', model, effort, systemPrompt, prompt, ['low', 'medium', 'high']);
  const accessToken = await readCodexAccess(authPath);
  let adapter;
  try { adapter = await import(pathToFileURL(await findCodexAdapter(adapterPath)).href); }
  catch (error) {
    if (error instanceof BenchmarkTransportError) throw error;
    throw fail('codex', 'ADAPTER_LOAD_FAILED');
  }
  if (typeof adapter.stream !== 'function') throw fail('codex', 'ADAPTER_LOAD_FAILED');
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let httpStatus = null;
  let capture = Promise.resolve({ value: null });
  let calls = 0;
  try {
    const output = await adapter.stream({
      id: model, name: model, api: 'openai-codex-responses', provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api', reasoning: true, input: ['text'],
      contextWindow: model === 'gpt-6.1-sol' ? 500000 : 272000, maxTokens: 128000,
      // Metadata required by the adapter. Official equivalent cost is calculated separately.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }, {
      systemPrompt, messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }, {
      apiKey: accessToken, transport: 'sse', reasoningEffort: effort,
      serviceTier: 'default', toolChoice: 'none', maxRetries: 0,
      signal, timeoutMs: TIMEOUT_MS,
      onPayload(payload) {
        const body = { ...payload, service_tier: 'default', reasoning: { effort }, tool_choice: 'none' };
        delete body.include; // No encrypted reasoning is needed for a one-turn translation.
        delete body.parallel_tool_calls;
        return body;
      },
      async fetch(url, options) {
        if (String(url) !== CODEX_ENDPOINT || ++calls > 1) throw fail('codex', 'UNEXPECTED_REQUEST');
        const response = await fetchImpl(url, { ...options, redirect: 'error', signal });
        httpStatus = response.status;
        if (response.ok) {
          // Catch immediately to prevent an unhandled rejection while the adapter consumes its copy.
          capture = readTerminalMetadata(response.clone()).then((value) => ({ value }), () => ({ error: true }));
        }
        return response;
      },
    }).result();
    const metadata = await capture;
    if (httpStatus !== null && (httpStatus < 200 || httpStatus >= 300) && !metadata.value?.rawUsage) throw fail('codex', 'HTTP_ERROR', httpStatus);
    if (metadata.error || !metadata.value) throw fail('codex', 'METADATA_MISSING', httpStatus);
    if (!metadata.value.rawUsage || typeof metadata.value.rawUsage !== 'object') throw fail('codex', 'USAGE_MISSING', httpStatus);
    const text = (output.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const complete = output.stopReason === 'stop' && text.trim()
      && (!metadata.value.status || metadata.value.status === 'completed');
    return {
      text, ...metadata.value,
      providerStatus: metadata.value.status,
      status: complete ? 'completed' : metadata.value.status === 'incomplete' || output.stopReason === 'length' ? 'incomplete' : 'failed',
      ...(complete ? {} : { errorCode: text.trim() ? 'INCOMPLETE_RESPONSE' : 'EMPTY_RESPONSE' }),
      normalizedUsage: normalizeUsage(metadata.value.rawUsage, 'codex'),
      httpStatus, finishReason: output.stopReason,
      ...timings(startedAt, started),
    };
  } catch (error) {
    if (error instanceof BenchmarkTransportError) throw error;
    throw fail('codex', signal.aborted ? 'TIMEOUT' : 'REQUEST_FAILED', httpStatus);
  }
}
