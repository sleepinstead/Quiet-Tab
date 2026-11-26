const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../ext/state.js'), 'utf8');
const { normalizeSettings, mergeValue, imageDataBlob } = vm.runInNewContext(source + '\nQuietTabState', {
  structuredClone, URL, Blob, Uint8Array, atob
});
const plain = value => JSON.parse(JSON.stringify(value));

test('normalizes old records, invalid controls and duplicate identifiers', () => {
  const settings = normalizeSettings({
    mode: 'dark', colors: { text: 'invalid' }, clockSize: Infinity, patOp: -4,
    links: [{ id: 7, url: 'example.org' }, { id: 7, url: 'example.com' }, { id: 8, url: 'file:///tmp' }],
    board: [{ id: 'bg', type: 'img' }, { id: 'note_7', type: 'note', x: 0.4, y: 0.3, text: 'Old note' }]
  });
  assert.equal(settings.colors.text, '#ececee');
  assert.equal(settings.clockSize, 100);
  assert.equal(settings.patOp, 5);
  assert.equal(settings.board[0].x, 0.4);
  assert.equal(settings.board.length, 1);
  assert.deepEqual(plain(settings.links), [{ id: 7, name: '', url: 'https://example.org/' }]);
});

test('merges independent edits, additions and removals across tabs', () => {
  const base = [{ id: 'a', text: 'A', x: 0 }, { id: 'b', text: 'B' }];
  const remote = [{ id: 'a', text: 'A', x: 7 }, { id: 'c', text: 'C' }];
  assert.deepEqual(plain(mergeValue(base, [
    { ...base[0], text: 'Updated' }, { ...base[1], text: 'Stale' }, { id: 'd', text: 'D' }
  ], remote)), [{ id: 'a', text: 'Updated', x: 7 }, remote[1], { id: 'd', text: 'D' }]);
});

test('backup images must contain local raster data', () => {
  for (const value of [null, '', 'https://example.org/photo.png', 'data:text/plain;base64,YQ==']) {
    assert.throws(() => imageDataBlob(value));
  }
  assert.equal(imageDataBlob('data:image/png;base64,YQ==').type, 'image/png');
});
