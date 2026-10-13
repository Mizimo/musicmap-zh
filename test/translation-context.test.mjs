import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranslationContexts, MAX_CONTEXT_CHARACTERS } from '../lib/translation-context.mjs';

test('linked fragments receive their full paragraph and genre heading without changing keys', () => {
  const source = ['Before', 'Jazz', 'after.', 'Other paragraph.', 'GROUP MUSIC'];
  const genres = { jazz: { name: 'GROUP <span>MUSIC</span>', description: 'Before <a data-code="j">Jazz</a> after.<br><br>Other paragraph.' } };
  const context = buildTranslationContexts({ source, genres });
  assert.match(context.get('Before'), /Genre: GROUP MUSIC/);
  assert.match(context.get('Before'), /Reference paragraph: Before Jazz after\./);
  assert.match(context.get('Jazz'), /Before Jazz after\./);
  assert.doesNotMatch(context.get('Before'), /Other paragraph/);
  assert.equal(context.get('Other paragraph.'), 'Genre: GROUP MUSIC; field: description');
  assert.match(context.get('GROUP MUSIC'), /field: genre name/);
  assert.deepEqual(source, ['Before', 'Jazz', 'after.', 'Other paragraph.', 'GROUP MUSIC']);
  assert.equal(context.has('Before Jazz after.'), false);
});

test('context follows extraction exclusions and handles text attributes and page headings', () => {
  const source = ['Heading', 'Visible', 'Linked', 'Search', 'Ignore', 'Song', 'Person'];
  const html = '<h2>Heading</h2><p>Visible <a>Linked</a></p><input placeholder="Search"><script>Ignore</script><div class="song-title">Song</div><div id="people-list">Person</div>';
  const context = buildTranslationContexts({ source, html });
  assert.match(context.get('Visible'), /section: Heading/);
  assert.match(context.get('Linked'), /Reference paragraph: Visible Linked/);
  assert.match(context.get('Search'), /input attribute: placeholder/);
  for (const excluded of ['Ignore', 'Song', 'Person']) assert.equal(context.has(excluded), false);
});

test('multiple occurrences are distinct, deterministic, and bounded even for huge paragraphs', () => {
  const source = ['linked'];
  const paragraph = value => `<section><h2>${value}</h2><p>${'long text '.repeat(100)}<a>linked</a>${' trailing '.repeat(100)}</p></section>`;
  const html = [paragraph('First'), paragraph('Second'), paragraph('Third'), paragraph('Fourth')].join('');
  const first = buildTranslationContexts({ source, html });
  const second = buildTranslationContexts({ source, html });
  assert.deepEqual(first, second);
  assert.ok(first.get('linked').length <= MAX_CONTEXT_CHARACTERS);
  assert.equal(first.get('linked').split('\n\n').length, 3);
  assert.doesNotMatch(first.get('linked'), /Fourth/);
  assert.ok(first.get('linked').includes('linked'));
});

test('headings inside one section do not leak into unrelated page sections', () => {
  const contexts = buildTranslationContexts({ source: ['Store text', 'Map label'], html: '<section><h2>STORE</h2><p>Store text</p></section><section><svg><text>Map label</text></svg></section>' });
  assert.match(contexts.get('Store text'), /section: STORE/);
  assert.doesNotMatch(contexts.get('Map label'), /STORE/);
});
