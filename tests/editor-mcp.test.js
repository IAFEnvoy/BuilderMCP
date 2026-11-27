import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editorMcp } from '../src/editor-mcp.js';
import { BuildScene, emptyProject, stateOf } from '../src/scene.js';

test('MCP checks current permissions and targets the active project for every request', async () => {
  const first = new BuildScene(emptyProject());
  const second = new BuildScene(emptyProject());
  let scene = first;
  let access = 'disabled';
  const call = editorMcp(() => scene, {
    access: () => access,
    catalog: () => ({ state: stateOf }),
    status() {},
  });
  const blocks = [{ pos: [0, 0, 0], state: 'minecraft:stone' }];
  await assert.rejects(call('list_blocks', {}), /disabled/);
  access = 'read_only';
  assert.equal((await call('list_blocks', {})).total, 0);
  for (const name of ['set_blocks', 'set_camera', 'select_box', 'open_project', 'save_project', 'export_structure', 'import_resource_pack']) {
    await assert.rejects(call(name, { blocks }), /read-only/);
  }
  assert.equal(first.blocks.size, 0);
  access = 'read_write';
  await call('set_blocks', { blocks });
  scene = second;
  assert.equal((await call('list_blocks', {})).total, 0);
  await call('set_blocks', { blocks: [{ ...blocks[0], state: 'minecraft:glass' }] });
  assert.equal(first.blocks.values().next().value.state.name, 'minecraft:stone');
  assert.equal(second.blocks.values().next().value.state.name, 'minecraft:glass');
});
