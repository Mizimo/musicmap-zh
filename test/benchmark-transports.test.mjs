import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BenchmarkTransportError, codexRequest, deepseekRequest } from '../lib/benchmark-transports.mjs';

const input = { model: 'deepseek-v4-pro', effort: 'high', systemPrompt: 'Translate into Chinese.', prompt: 'Music source.' };

test('DeepSeek sends one thinking request and retains only text, usage and actual metadata', async () => {
  let calls = 0;
  const rawUsage = { prompt_tokens: 100, prompt_cache_hit_tokens: 30, prompt_cache_miss_tokens: 70,
    completion_tokens: 80, completion_tokens_details: { reasoning_tokens: 60 }, total_tokens: 180 };
  const result = await deepseekRequest({ ...input, key: 'test-secret', fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, [{ role: 'system', content: input.systemPrompt }, { role: 'user', content: input.prompt }]);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.max_tokens, 16000);
    assert.equal(body.stream, false);
    return Response.json({ model: 'deepseek-v4-pro-actual', usage: rawUsage,
      choices: [{ finish_reason: 'stop', message: { content: '音乐。', reasoning_content: 'DO NOT PERSIST REASONING' } }] });
  } });
  assert.equal(calls, 1);
  assert.equal(result.text, '音乐。');
  assert.equal(result.returnedModel, 'deepseek-v4-pro-actual');
  assert.equal(result.returnedEffort, null);
  assert.deepEqual(result.rawUsage, rawUsage);
  assert.deepEqual(result.normalizedUsage, { inputTokens: 100, uncachedInputTokens: 70, cachedInputTokens: 30,
    cacheWriteInputTokens: null, outputTokens: 80, reasoningTokens: 60, totalTokens: 180 });
  assert.equal(result.status, 'completed');
  assert.ok(result.latencyMs >= 0);
  assert.ok(!JSON.stringify(result).includes('DO NOT PERSIST'));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

test('DeepSeek failures do not retry or expose upstream error bodies or network exceptions', async () => {
  for (const status of [400, 401, 429, 500]) {
    let calls = 0;
    await assert.rejects(deepseekRequest({ ...input, key: 'test-secret', fetchImpl: async () => {
      calls++;
      return new Response('test-secret reflected in error body', { status });
    } }), (error) => error instanceof BenchmarkTransportError && error.status === status
      && error.code === 'HTTP_ERROR' && !JSON.stringify(error).includes('test-secret'));
    assert.equal(calls, 1);
  }
  await assert.rejects(deepseekRequest({ ...input, key: 'test-secret', fetchImpl: () => {
    throw new Error('test-secret reflected in network error');
  } }), (error) => error.code === 'REQUEST_FAILED' && !error.message.includes('test-secret'));
});

test('DeepSeek marks incomplete translations while retaining usage for cost accounting', async () => {
  const payload = { choices: [{ finish_reason: 'length', message: { content: '半句' } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
  const incomplete = await deepseekRequest({ ...input, key: 'test', fetchImpl: async () => Response.json(payload) });
  assert.equal(incomplete.status, 'incomplete');
  assert.equal(incomplete.errorCode, 'INCOMPLETE_RESPONSE');
  assert.equal(incomplete.rawUsage.total_tokens, 30);
  payload.choices[0].finish_reason = 'stop';
  const result = await deepseekRequest({ ...input, key: 'test', fetchImpl: async () => Response.json(payload) });
  assert.equal(result.normalizedUsage.reasoningTokens, null);
  assert.equal(result.normalizedUsage.cachedInputTokens, null);
});

test('DeepSeek preserves charged usage on an HTTP error without returning the error body', async () => {
  const result = await deepseekRequest({ ...input, key: 'test', fetchImpl: async () => Response.json({
    error: { message: 'test-secret-must-not-leak' }, usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
  }, { status: 500 }) });
  assert.equal(result.status, 'failed');
  assert.equal(result.rawUsage.total_tokens, 10);
  assert.equal(result.errorCode, 'HTTP_ERROR');
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});

function deepseekSse(chunks, { done = true } = {}) {
  const text = ': keepalive\r\n\r\n' + chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\r\n\r\n`).join('')
    + (done ? 'data: [DONE]\r\n\r\n' : '');
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    // Split UTF-8 characters, JSON, and SSE frame boundaries across network reads.
    for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.slice(offset, offset + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('DeepSeek streaming captures terminal usage in either documented final-choice or usage-only layout', async () => {
  const usage = { prompt_tokens: 10, prompt_cache_hit_tokens: 0, completion_tokens: 30,
    completion_tokens_details: { reasoning_tokens: 20 }, total_tokens: 40 };
  for (const separateUsage of [false, true]) {
    let calls = 0;
    const result = await deepseekRequest({ ...input, key: 'test-secret', stream: true, timeoutMs: 600000,
      fetchImpl: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.stream, true);
        assert.deepEqual(body.stream_options, { include_usage: true });
        assert.equal(body.max_tokens, 16000);
        const chunks = [
          { model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { reasoning_content: 'DO NOT PERSIST REASONING' }, finish_reason: null }], usage: null },
          { model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { content: '爵士' }, finish_reason: null }], usage: null },
          { model: 'deepseek-v4-pro', choices: [{ index: 0, delta: { content: '音乐🎵' }, finish_reason: null }], usage: null },
          { model: 'deepseek-v4-pro', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: separateUsage ? null : usage },
        ];
        if (separateUsage) chunks.push({ model: 'deepseek-v4-pro', choices: [], usage });
        return deepseekSse(chunks);
      } });
    assert.equal(calls, 1);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, '爵士音乐🎵');
    assert.equal(result.returnedModel, 'deepseek-v4-pro');
    assert.equal(result.returnedEffort, null);
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.transport, 'sse');
    assert.equal(result.streamTransport, true);
    assert.deepEqual(result.rawUsage, usage);
    assert.ok(!JSON.stringify(result).includes('DO NOT PERSIST'));
    assert.ok(!JSON.stringify(result).includes('test-secret'));
  }
});

test('DeepSeek streaming retains charged usage and marks a missing DONE terminator incomplete', async () => {
  const usage = { prompt_tokens: 10, completion_tokens: 30, total_tokens: 40 };
  const result = await deepseekRequest({ ...input, key: 'test-secret', stream: true,
    fetchImpl: async () => deepseekSse([{ choices: [{ index: 0, delta: { content: '部分文字' }, finish_reason: 'stop' }], usage }], { done: false }) });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.errorCode, 'STREAM_INTERRUPTED');
  assert.equal(result.rawUsage.total_tokens, 40);
});

test('DeepSeek streaming missing-usage errors retain only allowlisted upstream diagnostic codes', async () => {
  for (const [upstream, expected] of [[{ code: 'gateway_timeout', status: 504 }, 'GATEWAY_TIMEOUT'],
    [{ code: 'test-secret', status: 504 }, 'UNKNOWN_UPSTREAM_ERROR']]) {
    await assert.rejects(deepseekRequest({ ...input, key: 'test-secret', stream: true,
      fetchImpl: async () => deepseekSse([{ error: { ...upstream, message: 'test-secret reflected by upstream' } }]) }), (error) => {
      assert.equal(error.code, 'USAGE_MISSING');
      assert.equal(error.httpStatus, 200);
      assert.equal(error.upstreamCode, expected);
      assert.equal(error.upstreamStatus, 504);
      assert.ok(!JSON.stringify(error).includes('test-secret'));
      assert.ok(!error.message.includes('test-secret'));
      return true;
    });
  }
});

test('DeepSeek JSON errors under a streaming request retain sanitized diagnostics', async () => {
  await assert.rejects(deepseekRequest({ ...input, key: 'test-secret', stream: true,
    fetchImpl: async () => Response.json({ error: { type: 'server_error', message: 'test-secret' } }) }),
  (error) => error.code === 'USAGE_MISSING' && error.upstreamCode === 'SERVER_ERROR' && !JSON.stringify(error).includes('test-secret'));
});

async function codexFixture(t, { expired = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'musicmap-codex-transport-'));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const authPath = join(directory, 'auth.json');
  const adapterPath = join(directory, 'adapter.mjs');
  const token = `test.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + (expired ? -60 : 3600) })).toString('base64url')}.signature`;
  await writeFile(authPath, JSON.stringify({ tokens: { access_token: token, refresh_token: 'never-refresh-this-secret' } }));
  await writeFile(adapterPath, `
export function stream(model, context, options) {
  return { async result() {
    const body = options.onPayload({ model: model.id, instructions: context.systemPrompt,
      input: context.messages, include: ['reasoning.encrypted_content'], parallel_tool_calls: true });
    const response = await options.fetch('https://chatgpt.com/backend-api/codex/responses', {
      method: 'POST', headers: { Authorization: 'Bearer ' + options.apiKey }, body: JSON.stringify(body) });
    await response.text();
    return response.ok
      ? { stopReason: 'stop', content: [{ type: 'text', text: '爵士 (Jazz)。' }, { type: 'thinking', thinking: 'do-not-save-this' }] }
      : { stopReason: 'error', errorMessage: 'secret-upstream-error', content: [] };
  } };
}
`);
  return { authPath, adapterPath, token };
}

function sseResponse(terminal) {
  const encoder = new TextEncoder();
  const text = `event: response.reasoning_text.delta\r\ndata: {"type":"response.reasoning_text.delta","delta":"DO NOT SAVE"}\r\n\r\n`
    + `data: ${JSON.stringify({ type: 'response.completed', response: terminal })}\r\n\r\ndata: [DONE]\r\n\r\n`;
  // Split both CRLF boundaries and JSON across network chunks.
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < text.length; offset += 17) controller.enqueue(encoder.encode(text.slice(offset, offset + 17)));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
}

test('Codex captures actual streamed model, effort, tier and full usage without agent overhead', async (t) => {
  const fixture = await codexFixture(t);
  const before = await readFile(fixture.authPath, 'utf8');
  const rawUsage = { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 30 },
    output_tokens: 80, output_tokens_details: { reasoning_tokens: 60 }, total_tokens: 180 };
  let calls = 0;
  const result = await codexRequest({ ...input, ...fixture, model: 'gpt-6.1-sol', effort: 'medium',
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'https://chatgpt.com/backend-api/codex/responses');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Bearer ${fixture.token}`);
      const body = JSON.parse(options.body);
      assert.equal(body.instructions, input.systemPrompt);
      assert.equal(body.input[0].content, input.prompt);
      assert.equal(body.service_tier, 'default');
      assert.deepEqual(body.reasoning, { effort: 'medium' });
      assert.equal(body.tool_choice, 'none');
      assert.ok(!('include' in body));
      assert.ok(!('max_output_tokens' in body));
      return sseResponse({ model: 'gpt-6.1-sol-actual', reasoning: { effort: 'medium' }, service_tier: 'default',
        status: 'completed', usage: rawUsage, output: [{ encrypted_content: 'DO NOT SAVE ENCRYPTED' }] });
    } });
  assert.equal(calls, 1);
  assert.equal(result.text, '爵士 (Jazz)。');
  assert.equal(result.returnedModel, 'gpt-6.1-sol-actual');
  assert.equal(result.returnedEffort, 'medium');
  assert.equal(result.serviceTier, 'default');
  assert.deepEqual(result.rawUsage, rawUsage);
  assert.deepEqual(result.normalizedUsage, { inputTokens: 100, uncachedInputTokens: 50, cachedInputTokens: 20,
    cacheWriteInputTokens: 30, outputTokens: 80, reasoningTokens: 60, totalTokens: 180 });
  assert.ok(!JSON.stringify(result).includes('DO NOT SAVE'));
  assert.ok(!JSON.stringify(result).includes(fixture.token));
  assert.equal(await readFile(fixture.authPath, 'utf8'), before);
});

test('Codex does not infer actual metadata from the request and rejects missing usage', async (t) => {
  const fixture = await codexFixture(t);
  const result = await codexRequest({ ...input, ...fixture, model: 'gpt-6-sol',
    fetchImpl: async () => sseResponse({ status: 'completed', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }) });
  assert.equal(result.returnedModel, null);
  assert.equal(result.returnedEffort, null);
  assert.equal(result.serviceTier, null);
  await assert.rejects(codexRequest({ ...input, ...fixture, model: 'gpt-6-sol',
    fetchImpl: async () => sseResponse({ status: 'completed' }) }), { code: 'USAGE_MISSING' });
});

test('Codex sends supplementary Astra efforts exactly and supports an extended timeout', async (t) => {
  const fixture = await codexFixture(t);
  for (const effort of ['xhigh', 'ultra', 'max']) {
    let calls = 0;
    const result = await codexRequest({ ...input, ...fixture, model: 'gpt-6-astra', effort, timeoutMs: 600000,
      fetchImpl: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        assert.equal(body.model, 'gpt-6-astra');
        assert.deepEqual(body.reasoning, { effort });
        return sseResponse({ model: 'gpt-6-astra', reasoning: { effort }, status: 'completed',
          usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } });
      } });
    assert.equal(calls, 1);
    assert.equal(result.returnedEffort, effort);
    assert.equal(result.status, 'completed');
  }
});

test('Codex preserves a returned effort that differs from the requested effort', async (t) => {
  const fixture = await codexFixture(t);
  const result = await codexRequest({ ...input, ...fixture, model: 'gpt-6-astra', effort: 'ultra',
    fetchImpl: async () => sseResponse({ model: 'gpt-6-astra', reasoning: { effort: 'max' }, status: 'completed',
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }) });
  assert.equal(result.returnedEffort, 'max');
});

test('Codex rejects invalid timeouts before authentication or network access', async () => {
  for (const timeoutMs of [0, -1, 600001, 1.5, '600000', null, NaN, Infinity]) {
    await assert.rejects(codexRequest({ ...input, model: 'gpt-6-astra', effort: 'xhigh', timeoutMs,
      authPath: '/not-a-real-auth-file', fetchImpl: () => assert.fail('No request with an invalid timeout') }),
    { code: 'INVALID_CONFIGURATION' });
  }
});

test('Codex classifies only precise structured effort rejections without retaining error text', async (t) => {
  const fixture = await codexFixture(t);
  const cases = [
    [{ param: 'reasoning.effort', code: 'unsupported_value' }, 'REASONING_EFFORT_REJECTED'],
    [{ param: 'reasoning.effort', code: 'invalid_value' }, 'REASONING_EFFORT_REJECTED'],
    [{ param: 'model', code: 'unsupported_value' }, 'HTTP_ERROR'],
    [{ param: 'reasoning.effort', code: 'invalid_request_error' }, 'HTTP_ERROR'],
    [{ code: 'unsupported_value' }, 'HTTP_ERROR'],
  ];
  for (const [error, expected] of cases) {
    let calls = 0;
    await assert.rejects(codexRequest({ ...input, ...fixture, model: 'gpt-6-astra', effort: 'ultra',
      fetchImpl: async () => {
        calls++;
        return Response.json({ error: { ...error, message: 'secret-upstream-error' } }, { status: 400 });
      } }), (error) => error.code === expected && error.httpStatus === 400
        && !JSON.stringify(error).includes('secret-upstream-error'));
    assert.equal(calls, 1);
  }
});

test('Codex auth and HTTP errors are sanitized and never refresh or retry', async (t) => {
  const expired = await codexFixture(t, { expired: true });
  await assert.rejects(codexRequest({ ...input, ...expired, model: 'gpt-6-astra',
    fetchImpl: () => assert.fail('No request with expired credentials') }), { code: 'AUTH_EXPIRED' });
  const fixture = await codexFixture(t);
  let calls = 0;
  await assert.rejects(codexRequest({ ...input, ...fixture, model: 'gpt-6-astra', fetchImpl: async () => {
    calls++;
    return new Response('secret-upstream-error', { status: 401 });
  } }), (error) => error.status === 401 && error.code === 'HTTP_ERROR' && !error.message.includes('secret-upstream-error'));
  assert.equal(calls, 1);
});

test('Codex retains charged usage when the provider terminal status is incomplete', async (t) => {
  const fixture = await codexFixture(t);
  const result = await codexRequest({ ...input, ...fixture, model: 'gpt-6-sol',
    fetchImpl: async () => sseResponse({ status: 'incomplete', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }) });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.providerStatus, 'incomplete');
  assert.equal(result.rawUsage.total_tokens, 30);
});
