import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BuildScene, cellKey, emptyProject, MAX_COORDINATE } from '../src/scene.js';

test('pasting a copied sparse selection preserves its states and undoes all edits together', () => {
  const first = { pos: [-3, 2, 5], state: { name: 'example:stairs', properties: { facing: 'west', half: 'top' } } };
  const second = { pos: [-1, 3, 6], state: { name: 'example:panel' } };
  const replaced = { pos: [8, 0, -4], state: { name: 'example:wall' } };
  const inGap = { pos: [9, 0, -4], state: { name: 'example:beam' } };
  const scene = new BuildScene({ ...emptyProject(), blocks: [first, second, replaced, inGap] });
  const blockAt = pos => scene.blocks.get(cellKey(pos));

  scene.selectBox(first.pos, second.pos);
  const revision = scene.revision;
  assert.deepEqual(scene.copySelection(), { count: 2, size: [3, 2, 2] });
  assert.equal(scene.revision, revision);
  assert.equal(scene.history.length, 0);
  scene.setBlocks([{ pos: first.pos, state: 'example:edited' }]);

  const pasted = [{ ...first, pos: replaced.pos }, { ...second, pos: [10, 1, -3] }];
  assert.equal(scene.pasteSelection(replaced.pos), 2);
  assert.deepEqual(scene.selected, pasted);
  assert.deepEqual(blockAt(inGap.pos), inGap);
  assert.equal(blockAt(first.pos).state.name, 'example:edited');

  assert.equal(scene.undo(), true);
  assert.deepEqual(blockAt(replaced.pos), replaced);
  assert.equal(blockAt(pasted[1].pos), undefined);
  assert.deepEqual(scene.selected.map(({ pos }) => pos), [first.pos, second.pos]);
  assert.equal(scene.redo(), true);
  assert.deepEqual(scene.selected, pasted);
});

test('the clipboard is reusable across projects and rejects out-of-bounds pastes atomically', () => {
  const scene = new BuildScene(emptyProject());
  assert.throws(() => scene.pasteSelection([0, 0, 0]), /请先复制/);
  scene.setBlocks([{ pos: [0, 0, 0], state: 'example:base' }, { pos: [1, 0, 0], state: 'example:cap' }]);
  scene.select(scene.blocks.keys());
  scene.copySelection();
  scene.load(emptyProject());
  assert.throws(() => scene.copySelection(), /请先选择/);

  const revision = scene.revision;
  assert.throws(() => scene.pasteSelection([MAX_COORDINATE, 0, 0]), /粘贴末端/);
  assert.equal(scene.revision, revision);
  assert.equal(scene.blocks.size, 0);
  assert.equal(scene.history.length, 0);

  assert.equal(scene.pasteSelection([0, 0, 0]), 2);
  assert.equal(scene.pasteSelection([4, 0, 0]), 2);
  const pastedRevision = scene.revision;
  assert.equal(scene.pasteSelection([0, 0, 0]), 0);
  assert.equal(scene.revision, pastedRevision);
  assert.equal(scene.history.length, 2);
  assert.deepEqual(scene.selected.map(({ pos }) => pos), [[0, 0, 0], [1, 0, 0]]);
});

test('scene changes report the block data applied by edits, undo, and redo', () => {
  const pos = [0, 0, 0];
  const key = cellKey(pos);
  const initial = { pos, state: { name: 'minecraft:red_banner', properties: { rotation: '0' } } };
  const edited = { pos, state: initial.state, blockEntity: { patterns: [{ pattern: 'minecraft:rhombus', color: 'blue' }] } };
  const scene = new BuildScene({ ...emptyProject(), blocks: [initial] });
  const recordedBlocks = [];
  scene.onChange(({ changes, side }) => {
    if (changes?.size) recordedBlocks.push(changes.get(key)[side]);
  });

  scene.setBlocks([edited]);
  scene.select([key]);
  scene.setBlocks([edited]);
  scene.setBlocks([{ pos, state: null }]);
  scene.undo();
  scene.undo();
  scene.redo();

  assert.deepEqual(recordedBlocks, [edited, null, edited, initial, edited]);
});
test('scenes in separate project tabs share the clipboard and keep independent history', () => {
  const clipboard = { selection: null };
  const first = new BuildScene(emptyProject(), clipboard);
  const second = new BuildScene(emptyProject(), clipboard);
  first.setBlocks([{ pos: [0, 0, 0], state: 'stone' }]);
  first.selectBox([0, 0, 0], [0, 0, 0]);
  first.copySelection();
  second.pasteSelection([4, 0, 0]);
  assert.deepEqual(first.selected.map(block => block.pos), [[0, 0, 0]]);
  assert.deepEqual(second.selected.map(block => block.pos), [[4, 0, 0]]);
  assert.equal(first.undo(), true);
  assert.equal(first.blocks.size, 0);
  assert.equal(second.blocks.size, 1);
  assert.equal(second.undo(), true);
  assert.equal(second.blocks.size, 0);
  assert.deepEqual(first.clipboardSize, [1, 1, 1]);
});
