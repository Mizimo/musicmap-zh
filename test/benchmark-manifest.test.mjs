import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { extendManifest } from '../lib/benchmark-manifest.mjs';

const high = { id: 'gpt-6-astra-high', provider: 'codex', model: 'gpt-6-astra', effort: 'high' };
const max = { ...high, id: 'gpt-6-astra-max', effort: 'max' };
const previous = { promptHash: 'p', sourceHash: 's', pricingHash: 'r', glossaryHash: 'g', bandOverride: null,
  configurations: [high], gitCommit: 'original', methodology: { retries: 0 } };
const current = { ...previous, configurations: [high, max], gitCommit: 'supplement' };

test('new configurations require explicit append while existing-only resume is unchanged', () => {
  assert.throws(() => extendManifest(previous, current, [max]), /--append-configurations/);
  assert.deepEqual(extendManifest(previous, current, [high]), { manifest: previous, changed: false });
});

test('append preserves frozen inputs and old configurations with verifiable history', () => {
  const before = JSON.stringify(previous);
  const result = extendManifest(previous, current, [max], { allowAppend: true, recordedAt: 'supplement-time' });
  assert.equal(JSON.stringify(previous), before);
  assert.deepEqual(result.manifest.configurations, [high, max]);
  assert.equal(result.manifest.gitCommit, 'original');
  assert.deepEqual(JSON.parse(result.previousText), previous);
  const extension = result.manifest.configurationExtensions[0];
  assert.equal(extension.previousManifestSha256, createHash('sha256').update(result.previousText).digest('hex'));
  assert.equal(extension.gitCommit, 'supplement');
  assert.equal(extendManifest(result.manifest, current, [max], { allowAppend: true }).changed, false);
});

test('append refuses changed frozen inputs or redefined old configurations', () => {
  for (const key of ['promptHash', 'sourceHash', 'pricingHash', 'glossaryHash', 'bandOverride']) {
    assert.throws(() => extendManifest(previous, { ...current, [key]: 'changed' }, [max], { allowAppend: true }), /Refusing resume/);
  }
  assert.throws(() => extendManifest(previous, { ...current, configurations: [{ ...high, effort: 'low' }, max] }, [max], { allowAppend: true }), /changed configuration/);
});
