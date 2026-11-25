import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gunzipSync } from 'fflate';
import { dataVersionFor } from '../src/minecraft-versions.js';
import { defaultJigsaw } from '../src/block-entities.js';
import { readNbt } from '../src/nbt.js';
import { BuildScene } from '../src/scene.js';
import { decodeStructure, encodeStructure } from '../src/structure.js';

test('Java structures retain sparse coordinates and state properties through a round trip', async () => {
  const project = {
    version: 1, name: 'Original', dataVersion: 3465,
    blocks: [
      { pos: [-8, 5, 9], state: { name: 'minecraft:oak_stairs', properties: { facing: 'west', half: 'top' } } },
      { pos: [-5, 9, 3], state: { name: 'example:tile' } },
    ],
  };
  const encoded = encodeStructure(project, 'nbt');
  const expected = {
    ...project, name: 'Fixture',
    blocks: project.blocks.map(block => ({ ...block, pos: [block.pos[0] + 8, block.pos[1] - 5, block.pos[2] - 3] })),
  };
  assert.deepEqual(await decodeStructure(encoded, 'nbt', 'Fixture'), expected);
  assert.deepEqual(await decodeStructure(gunzipSync(encoded), 'nbt', 'Fixture'), expected);
});

test('Litematica carries three-bit palette indices across long boundaries', async () => {
  const blocks = [];
  for (let y = 0; y < 2; y++) {
    for (let z = 0; z < 5; z++) {
      for (let x = 0; x < 9; x++) {
        if (x === 2 && z === 2) continue;
        const index = ((y * 5 + z) * 9 + x) % 5;
        blocks.push({ pos: [x, y, z], state: { name: 'example:panel', properties: { level: String(index) } } });
      }
    }
  }
  const project = { version: 1, name: '测试 🧱', dataVersion: 3955, blocks };
  const decoded = await decodeStructure(encodeStructure(project, 'litematic'), 'litematic', 'Fixture');
  assert.deepEqual(new BuildScene(decoded).snapshot(), project);
});

test('structure imports reject truncated NBT, damaged gzip and incompatible file types', async () => {
  const project = {
    version: 1, name: 'Fixture', dataVersion: 3955,
    blocks: [{ pos: [0, 0, 0], state: { name: 'example:tile' } }],
  };
  const bytes = encodeStructure(project, 'nbt');
  await assert.rejects(decodeStructure(bytes.subarray(0, -3), 'nbt'), /GZIP/);
  await assert.rejects(decodeStructure(gunzipSync(bytes).subarray(0, -1), 'nbt'), /不完整/);
  await assert.rejects(decodeStructure(bytes, 'litematic'), /Litematica/);
});

test('direct saves retain the Litematica origin and only translate negative axes for Java NBT', async () => {
  const project = {
    version: 1, name: 'Saved building', dataVersion: 3955,
    blocks: [
      { pos: [-5, 4, 3], state: { name: 'example:tile' } },
      { pos: [-2, 5, 8], state: { name: 'example:panel' } },
    ],
  };
  const options = { preserveOrigin: true };
  assert.deepEqual(await decodeStructure(encodeStructure(project, 'litematic', options), 'litematic'), project);
  const savedNbt = await decodeStructure(encodeStructure(project, 'nbt', options), 'nbt', project.name);
  assert.deepEqual(savedNbt.blocks.map(({ pos }) => pos), [[0, 4, 3], [3, 5, 8]]);
  const empty = { ...project, blocks: [] };
  for (const format of ['nbt', 'litematic']) {
    assert.deepEqual(await decodeStructure(encodeStructure(empty, format, options), format, empty.name), empty);
  }
});

test('browser exports use the selected release for the palette and schematic version', async () => {
  const blocks = [{ pos: [0, 0, 0], state: { name: 'minecraft:furnace', properties: { facing: 'east' } } }];
  const project = { version: 1, name: 'Fixture', dataVersion: dataVersionFor('26.3'), blocks };
  const nbt = await readNbt(encodeStructure(project, 'nbt'));
  assert.equal(nbt.DataVersion, 5023);
  assert.equal(nbt.palette[0].id, 'minecraft:furnace');
  assert.equal(nbt.palette[0].properties.facing, 'east');

  const projection = await readNbt(encodeStructure(project, 'litematic'));
  assert.equal(projection.MinecraftDataVersion, 5023);
  assert.equal(projection.Version, 7);
  assert.equal(projection.Regions.Main.BlockStatePalette[1].id, 'minecraft:furnace');

  const legacy = await readNbt(encodeStructure({ ...project, dataVersion: dataVersionFor('1.12.2') }, 'litematic'));
  assert.equal(legacy.MinecraftDataVersion, 1343);
  assert.equal(legacy.Version, 4);
  assert.equal(legacy.Metadata.TotalBlocks, 1n);
  assert.equal(legacy.Regions.Main.BlockStatePalette[1].Name, 'minecraft:furnace');
});

test('browser exports record the software version and unique placed block namespaces', async () => {
  const project = {
    version: 1, name: 'Fixture', dataVersion: 3955,
    blocks: ['create:casing', 'example:tile', 'create:shaft'].map((name, x) => ({ pos: [x, 0, 0], state: { name } })),
  };
  for (const format of ['nbt', 'litematic']) {
    const root = await readNbt(encodeStructure(project, format, { softwareVersion: '1.2.3' }));
    assert.equal(root.BuilderMCP.SoftwareVersion, '1.2.3');
    assert.deepEqual(root.BuilderMCP.BlockNamespaces, ['create', 'example']);
  }
});
test('Java structure formats retain per-block banner layers and jigsaw settings', async () => {
  const banner = { name: 'minecraft:red_wall_banner', properties: { facing: 'north' } };
  const jigsaw = { name: 'minecraft:jigsaw', properties: { orientation: 'up_north' } };
  const project = {
    version: 1, name: 'Fixture', dataVersion: 3955,
    blocks: [
      { pos: [2, 1, 0], state: banner, blockEntity: { patterns: [{ pattern: 'minecraft:stripe_top', color: 'blue' }] } },
      { pos: [3, 1, 0], state: banner, blockEntity: { patterns: [{ pattern: 'minecraft:rhombus', color: 'yellow' }] } },
      { pos: [4, 2, 0], state: jigsaw, blockEntity: { ...defaultJigsaw(jigsaw), pool: 'fixture:hall', selection_priority: 2 } },
    ],
  };
  for (const dataVersion of [3465, 3955, 5023]) {
    for (const format of ['nbt', 'litematic']) {
      const expected = { ...project, dataVersion };
      const encoded = encodeStructure(expected, format, { preserveOrigin: true });
      assert.deepEqual(await decodeStructure(encoded, format, project.name), expected);
      const tags = await readNbt(encoded);
      const bannerTag = format === 'nbt' ? tags.blocks[0].nbt : tags.Regions.Main.TileEntities[0];
      if (dataVersion < 3837) {
        assert.equal(bannerTag.Patterns[0].Pattern, 'ts');
        assert.equal(bannerTag.Patterns[0].Color, 11);
      } else {
        assert.equal(bannerTag.patterns[0].pattern, 'minecraft:stripe_top');
        assert.equal(bannerTag.patterns[0].color, 'blue');
      }
    }
  }
});
