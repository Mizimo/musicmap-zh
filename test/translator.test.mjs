import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTranslator, TranslationError } from '../lib/translator.mjs';

async function fixture(t, overrides = {}) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'musicmap-translator-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return {
    cacheDir,
    translator: createTranslator({ apiKey: 'test-secret', cacheDir, ...overrides }),
  };
}

function response(translations, finishReason = 'stop') {
  return Response.json({
    choices: [{ finish_reason: finishReason, message: { content: JSON.stringify({ translations }) } }],
  });
}

function requestTexts(options) {
  return JSON.parse(JSON.parse(options.body).messages[1].content).texts;
}

test('persists validated translations; serves cache without an API key after restart', async (t) => {
  let calls = 0;
  const { translator, cacheDir } = await fixture(t, {
    fetchImpl: async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.deepseek.com/chat/completions');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      assert.equal(options.redirect, 'error');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'deepseek-flash');
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.deepEqual(body.thinking, { type: 'disabled' });
      assert.deepEqual(requestTexts(options), ['Rock', 'History']);
      return response(['搖滾 (Rock)', '歷史']);
    },
  });
  const request = { texts: ['Rock', 'History', 'Rock'], language: 'zh-Hant' };
  assert.deepEqual(await translator.translate(request), {
    translations: ['搖滾 (Rock)', '歷史', '搖滾 (Rock)'], cached: 0,
  });
  assert.equal((await translator.translate(request)).cached, 3);
  const restarted = createTranslator({ cacheDir, fetchImpl: () => assert.fail('Unexpected API request') });
  assert.deepEqual(await restarted.translate(request), {
    translations: ['搖滾 (Rock)', '歷史', '搖滾 (Rock)'], cached: 3,
  });
  assert.equal(calls, 1);
  const files = await readdir(cacheDir);
  assert.equal(files.length, 2);
  assert.ok(files.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
});

test('cache keys isolate Chinese scripts, models, and API endpoints', async (t) => {
  let calls = 0;
  const fetchImpl = async () => response([`翻譯 ${++calls}`]);
  const { translator, cacheDir } = await fixture(t, { fetchImpl });
  assert.equal((await translator.translate({ texts: ['Rock'], language: 'zh-Hans' })).translations[0], '翻譯 1');
  assert.equal((await translator.translate({ texts: ['Rock'], language: 'zh-Hant' })).translations[0], '翻譯 2');
  const changedModel = createTranslator({ apiKey: 'test', model: 'custom-model', cacheDir, fetchImpl });
  assert.equal((await changedModel.translate({ texts: ['Rock'], language: 'zh-Hant' })).cached, 0);
  const changedEndpoint = createTranslator({ apiKey: 'test', baseUrl: 'https://example.test/v1', cacheDir, fetchImpl });
  assert.equal((await changedEndpoint.translate({ texts: ['Rock'], language: 'zh-Hant' })).cached, 0);
  assert.equal(calls, 4);
});

test('a missing API key rejects only requests with uncached text', async (t) => {
  const { translator } = await fixture(t, { apiKey: '', fetchImpl: () => assert.fail('Unexpected API request') });
  assert.deepEqual(await translator.translate({ texts: [], language: 'zh-Hans' }), { translations: [], cached: 0 });
  await assert.rejects(translator.translate({ texts: ['Soul'], language: 'zh-Hans' }), (error) => {
    assert.ok(error instanceof TranslationError);
    assert.equal(error.status, 503);
    assert.equal(error.code, 'API_KEY_MISSING');
    return true;
  });
});

test('invalid JSON, wrong counts/types, blanks, and truncated replies are never cached', async (t) => {
  for (const invalid of [
    () => response([]),
    () => response([42]),
    () => response(['']),
    () => response(['翻譯', '多餘']),
    () => response(['翻譯'], 'length'),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'not JSON' } }] }),
    () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{"translations":["翻譯"],"extra":true}' } }] }),
  ]) {
    let calls = 0;
    const { translator, cacheDir } = await fixture(t, {
      fetchImpl: async () => ++calls === 1 ? invalid() : response(['翻譯']),
    });
    const request = { texts: ['Text'], language: 'zh-Hant' };
    await assert.rejects(translator.translate(request), { status: 502 });
    assert.deepEqual(await readdir(cacheDir), []);
    assert.deepEqual(await translator.translate(request), { translations: ['翻譯'], cached: 0 });
    assert.equal(calls, 2);
  }
});

test('concurrent overlapping calls translate a shared text once and preserve each order', async (t) => {
  const seen = [];
  const { translator } = await fixture(t, {
    fetchImpl: async (_url, options) => {
      const texts = requestTexts(options);
      seen.push(...texts);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response(texts.map((text) => `譯：${text}`));
    },
  });
  const [first, second, third] = await Promise.all([
    translator.translate({ texts: ['Rock', 'Soul', 'Rock'], language: 'zh-Hant' }),
    translator.translate({ texts: ['Soul', 'Jazz'], language: 'zh-Hant' }),
    translator.translate({ texts: ['Jazz', 'Rock'], language: 'zh-Hant' }),
  ]);
  assert.deepEqual(first.translations, ['譯：Rock', '譯：Soul', '譯：Rock']);
  assert.deepEqual(second.translations, ['譯：Soul', '譯：Jazz']);
  assert.deepEqual(third.translations, ['譯：Jazz', '譯：Rock']);
  assert.deepEqual(seen.sort(), ['Jazz', 'Rock', 'Soul']);
});

test('API concurrency stays at two across translator instances', async (t) => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async (_url, options) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active -= 1;
    return response(requestTexts(options).map((text) => `譯：${text}`));
  };
  const first = await fixture(t, { fetchImpl });
  const second = await fixture(t, { fetchImpl });
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first.translator : second.translator).translate({ texts: [`Text ${index}`], language: 'zh-Hans' }),
  ));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

test('retries 429 and 5xx at most twice, but never retries auth or schema errors', async (t) => {
  for (const status of [429, 503, 401, 400]) {
    let calls = 0;
    const { translator, cacheDir } = await fixture(t, {
      fetchImpl: async () => {
        calls += 1;
        return new Response('test-secret reflected upstream', { status, headers: { 'Retry-After': '0' } });
      },
    });
    await assert.rejects(translator.translate({ texts: ['Rock'], language: 'zh-Hant' }), (error) => {
      assert.ok(!error.message.includes('test-secret'));
      assert.equal(error.code, status === 401 ? 'API_AUTH_FAILED' : 'UPSTREAM_ERROR');
      return true;
    });
    assert.equal(calls, status === 429 || status === 503 ? 3 : 1);
    assert.deepEqual(await readdir(cacheDir), []);
  }
});

test('a transient HTTP error can recover and then populate the cache', async (t) => {
  let calls = 0;
  const { translator } = await fixture(t, {
    fetchImpl: async () => ++calls === 1
      ? new Response('', { status: 503, headers: { 'Retry-After': '0' } })
      : response(['靈魂樂 (Soul)']),
  });
  const request = { texts: ['Soul'], language: 'zh-Hant' };
  assert.deepEqual((await translator.translate(request)).translations, ['靈魂樂 (Soul)']);
  assert.equal((await translator.translate(request)).cached, 1);
  assert.equal(calls, 2);
});

test('corrupt cache entries are replaced by valid translations', async (t) => {
  const { translator, cacheDir } = await fixture(t, { fetchImpl: async () => response(['爵士 (Jazz)']) });
  const request = { texts: ['Jazz'], language: 'zh-Hant' };
  await translator.translate(request);
  const [file] = await readdir(cacheDir);
  await writeFile(join(cacheDir, file), 'interrupted or malformed JSON');
  const restarted = createTranslator({ apiKey: 'test', cacheDir, fetchImpl: async () => response(['爵士樂 (Jazz)']) });
  assert.deepEqual(await restarted.translate(request), { translations: ['爵士樂 (Jazz)'], cached: 0 });
});

test('validates input bounds before making a request', async (t) => {
  const { translator } = await fixture(t, { fetchImpl: () => assert.fail('Unexpected API request') });
  for (const input of [
    undefined,
    { texts: ['Rock'], language: 'en' },
    { texts: 'Rock', language: 'zh-Hans' },
    { texts: [null], language: 'zh-Hans' },
    { texts: Array(33).fill('Rock'), language: 'zh-Hans' },
    { texts: ['a'.repeat(5001)], language: 'zh-Hans' },
    { texts: Array(4).fill('a'.repeat(4001)), language: 'zh-Hans' },
  ]) {
    await assert.rejects(translator.translate(input), { status: 400, code: 'INVALID_REQUEST' });
  }
});

test('network error messages never expose credentials or trigger retries', async (t) => {
  let calls = 0;
  const { translator } = await fixture(t, {
    fetchImpl: async () => {
      calls += 1;
      throw new Error('request failed with Bearer test-secret');
    },
  });
  await assert.rejects(translator.translate({ texts: ['Rock'], language: 'zh-Hans' }), (error) => {
    assert.equal(error.code, 'API_CONNECTION_FAILED');
    assert.ok(!String(error).includes('test-secret'));
    return true;
  });
  assert.equal(calls, 1);
});
