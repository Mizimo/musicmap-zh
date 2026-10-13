import { createHash } from 'node:crypto';

/** Extend a frozen run only by explicit opt-in, never replacing old configurations. */
export function extendManifest(previous, current, selected, { allowAppend = false, recordedAt = new Date().toISOString() } = {}) {
  for (const key of ['promptHash', 'sourceHash', 'pricingHash', 'glossaryHash', 'bandOverride']) {
    if (previous[key] !== current[key]) throw new Error(`Refusing resume with changed ${key}`);
  }
  const existing = new Map(previous.configurations.map(config => [config.id, config]));
  for (const config of current.configurations) {
    const old = existing.get(config.id);
    if (old && ['provider', 'model', 'effort'].some(key => old[key] !== config[key])) {
      throw new Error(`Refusing resume with changed configuration ${config.id}`);
    }
  }
  const additions = selected.filter(config => !existing.has(config.id));
  if (!additions.length) return { manifest: previous, changed: false };
  if (!allowAppend) throw new Error('New configurations require --append-configurations; existing results remain untouched');
  const previousText = JSON.stringify(previous, null, 2) + '\n';
  const previousHash = createHash('sha256').update(previousText).digest('hex');
  const previousFile = `manifest-history/${previousHash}.json`;
  return {
    changed: true, previousText, previousFile,
    manifest: {
      ...previous,
      configurations: [...previous.configurations, ...additions],
      configurationExtensions: [...(previous.configurationExtensions || []), {
        recordedAt, configurations: additions.map(config => config.id), gitCommit: current.gitCommit,
        previousManifestSha256: previousHash, previousManifestFile: previousFile,
        note: 'Additional configurations requested later; frozen source, prompt, glossary and prices unchanged. Existing results are not rerun.',
      }],
    },
  };
}
