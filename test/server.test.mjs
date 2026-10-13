import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('static server serves local assets and has no runtime translation endpoint', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mmzh-server-'));
  await writeFile(join(directory, 'index.html'), '<h1>fixture</h1>');
  await writeFile(join(directory, '.env'), 'secret');
  const server = createApp({ directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal(await fetch(url).then(r => r.text()), '<h1>fixture</h1>');
  assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${url}/.env`)).status, 403);
  assert.equal((await fetch(`${url}/_zh/api/translate`, { method: 'POST' })).status, 405);
  const rejected = await new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject);
  });
  assert.equal(rejected, 403);
});
