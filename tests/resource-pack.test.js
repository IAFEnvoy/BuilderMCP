import assert from 'node:assert/strict';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { BlockCatalog, loadArchive } from '../src/resource-pack.js';
import { buildGeometry } from '../src/model-geometry.js';
import { BuildScene, emptyProject } from '../src/scene.js';
import { textureFrameAt, textureTimeline } from '../src/texture-animation.js';

function archive(entries) {
  return zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [path, strToU8(typeof value === 'string' ? value : JSON.stringify(value))])));
}

test('the missing block is available to render without populating the empty project or catalog', async () => {
  const catalog = new BlockCatalog();
  const scene = new BuildScene(emptyProject());
  assert.equal(scene.blocks.size, 0);
  assert.equal(scene.bounds, null);
  assert.deepEqual(catalog.find(), []);
  const [placeholder] = catalog.parts(catalog.state('stone_bricks'), [0, 0, 0]);
  const [mesh] = buildGeometry(catalog, placeholder);
  assert.equal(mesh.geometry.getIndex().count, 36);
  mesh.geometry.dispose();
  assert.deepEqual(catalog.parts(catalog.state('air'), [0, 0, 0]), []);
  assert.equal(catalog.model('minecraft:block/cube_all'), null);
  assert.equal(await catalog.image('minecraft:block/stone_bricks'), null);
});

test('mod JAR labels try block and item keys in the current language before English', async () => {
  const definition = { variants: { '': { model: 'example:block/shelf' } } };
  const mod = await loadArchive(archive({
    'assets/example/blockstates/shelf.json': definition,
    'assets/example/blockstates/panels/pine.json': definition,
    'assets/example/blockstates/plate.json': definition,
    'assets/example/blockstates/untranslated.json': definition,
    'assets/example/lang/en_us.json': {
      'block.example.shelf': 'Shelf block',
      'item.example.shelf': 'Shelf item',
      'item.example.panels.pine': 'Pine panel',
      'item.example.plate': 'English Plate',
    },
    'assets/example/lang/zh_cn.json': { 'item.example.shelf': '搁板物品', 'item.example.panels.pine': '松木镶板', 'block.example.plate': ' ' },
    'assets/example/lang/ja_JP.lang': '# Japanese translations\nblock.example.shelf=棚\nblock.example.plate=プレート',
  }));

  const catalog = new BlockCatalog([mod]);
  assert.deepEqual([...mod.languages.keys()].sort(), ['en_us', 'ja_jp', 'zh_cn']);
  assert.equal(catalog.blocks.get('example:shelf').label, '搁板物品');
  assert.equal(catalog.blocks.get('example:panels/pine').label, '松木镶板');
  assert.equal(catalog.blocks.get('example:plate').label, 'English Plate');
  assert.equal(catalog.blocks.get('example:untranslated').label, 'block.example.untranslated');
  assert.equal(catalog.label('example:unknown'), 'block.example.unknown');
  assert.equal(catalog.find('松木镶板')[0].name, 'example:panels/pine');
  assert.equal(catalog.find('Pine panel')[0].name, 'example:panels/pine');
  catalog.setLocale('ja_jp');
  assert.equal(catalog.blocks.get('example:shelf').label, '棚');
  assert.equal(catalog.blocks.get('example:panels/pine').label, 'Pine panel');
  catalog.setLocale('en_us');
  assert.equal(catalog.blocks.get('example:shelf').label, 'Shelf block');
});

test('language-only packs override official labels for the same key', async () => {
  const definition = { variants: { '': { model: 'minecraft:block/sample' } } };
  const blocks = await loadArchive(archive(Object.fromEntries(
    ['stone_bricks', 'cobblestone', 'oak_planks'].map(name => [`assets/minecraft/blockstates/${name}.json`, definition]),
  )));
  const base = await loadArchive(archive({
    'assets/minecraft/lang/en_us.json': { 'block.minecraft.stone_bricks': 'Stone Bricks' },
  }));
  const overlay = await loadArchive(archive({
    'assets/minecraft/lang/zh_cn.json': {
      'block.minecraft.stone_bricks': '石砖',
      'item.minecraft.cobblestone': '圆石',
    },
  }));

  const official = new Map([['zh_cn', new Map([
    ['block.minecraft.stone_bricks', '原版石砖'], ['block.minecraft.oak_planks', '橡木木板'],
  ])]]);
  assert.deepEqual(new BlockCatalog([base, overlay], 'zh_cn', official).find(), []);
  const catalog = new BlockCatalog([blocks, base, overlay], 'zh_cn', official);
  assert.equal(catalog.blocks.get('minecraft:stone_bricks').label, '石砖');
  assert.equal(catalog.blocks.get('minecraft:cobblestone').label, '圆石');
  assert.equal(catalog.blocks.get('minecraft:oak_planks').label, '橡木木板');
});

test('a client JAR exposes its Minecraft version for retrieving launcher translations', async () => {
  const version = { id: '26.3', world_version: 5023 };
  const versioned = { 'version.json': version, 'assets/minecraft/lang/en_us.json': { 'block.minecraft.stone': 'Stone' } };
  const client = await loadArchive(archive({
    ...versioned,
    'assets/minecraft/blockstates/stone.json': { variants: { '': { model: 'minecraft:block/stone' } } },
  }));
  assert.equal(client.minecraftVersion, '26.3');
  assert.equal((await loadArchive(archive(versioned))).minecraftVersion, null);
});

test('palette filtering uses exact namespaces and combines with category and language searches', async () => {
  const definition = { variants: { '': { model: 'minecraft:block/sample' } } };
  const pack = await loadArchive(archive({
    'assets/sample_plus/blockstates/slate_tiles.json': definition,
    'assets/sample/blockstates/slate_tiles.json': definition,
    'assets/sample/blockstates/oak_trim.json': definition,
    'assets/models_only/models/block/sample.json': {},
    'assets/sample/lang/en_us.json': { 'block.sample.slate_tiles': 'Dark Tile' },
    'assets/sample/lang/zh_cn.json': { 'block.sample.slate_tiles': '深色地砖' },
  }));
  const catalog = new BlockCatalog([pack, pack]);
  assert.deepEqual(catalog.namespaces, ['sample', 'sample_plus']);
  assert.deepEqual(catalog.find('', 'all', 'sample').map(block => block.name), ['sample:slate_tiles', 'sample:oak_trim']);
  assert.deepEqual(catalog.find('深色地砖', 'stone', 'sample').map(block => block.name), ['sample:slate_tiles']);
  assert.deepEqual(catalog.find('dark tile', 'stone', 'sample').map(block => block.name), ['sample:slate_tiles']);
  assert.deepEqual(catalog.find('slate', 'wood', 'sample'), []);
  assert.deepEqual(catalog.find('', 'all', 'sam'), []);

  const matches = catalog.searchMatcher('slate', 'stone', 'sample');
  assert.equal(matches('sample:slate_wall'), true);
  assert.equal(matches('sample_plus:slate_wall'), false);
  assert.equal(matches('sample:oak_trim'), false);
});

test('selection properties use common values and include states stored only in the project', async () => {
  const model = { model: 'example:block/sample' };
  const pack = await loadArchive(archive({
    'assets/example/blockstates/panel.json': { variants: { 'facing=north,lit=false': model, 'facing=east,lit=true': model } },
    'assets/example/blockstates/gate.json': { variants: { 'facing=north': model, 'facing=south': model } },
  }));
  const catalog = new BlockCatalog([pack]);
  const panel = { state: { name: 'example:panel', properties: { tint: 'light' } } };
  const gate = { state: { name: 'example:gate', properties: { facing: 'south', tint: 'dark' } } };
  assert.deepEqual(catalog.selectionProperties([panel]), [
    { key: 'facing', value: 'north', options: ['north', 'east'] },
    { key: 'lit', value: 'false', options: ['false', 'true'] },
    { key: 'tint', value: 'light', options: undefined },
  ]);
  assert.deepEqual(catalog.selectionProperties([panel, gate]), [
    { key: 'facing', value: undefined, options: ['north'] },
    { key: 'tint', value: undefined, options: undefined },
  ]);
  assert.deepEqual(catalog.selectionProperties([panel, { state: { name: 'example:unknown' } }]), []);
});

test('archive progress counts supported files including deferred language entries', async () => {
  const steps = [];
  const pack = await loadArchive(archive({
    'assets/example/blockstates/sample.json': { variants: { '': { model: 'example:block/sample' } } },
    'assets/example/lang/en_us.json': { 'block.example.sample': 'Sample' },
    ignored: 'outside assets',
  }), step => steps.push(step));
  assert.deepEqual(steps[0], { stage: 'unpack' });
  assert.deepEqual(steps[1], { stage: 'index', processed: 0, total: 2 });
  assert.deepEqual(steps.at(-1), { stage: 'index', processed: 2, total: 2 });
  assert.equal(new BlockCatalog([pack]).label('example:sample'), 'Sample');
});

test('texture metadata can come from the same pack as the image or from a higher pack', async () => {
  const png = 'assets/example/textures/block/panel.png';
  const baseAnimation = { frames: [0, 1] };
  const overrideAnimation = { frames: [1, 0] };
  const base = await loadArchive(archive({ [png]: 'base', [png + '.mcmeta']: { animation: baseAnimation } }));
  const metadata = await loadArchive(archive({ [png + '.mcmeta']: { animation: overrideAnimation } }));
  const replacement = await loadArchive(archive({ [png]: 'replacement' }));
  const key = 'example:block/panel';
  assert.deepEqual(new BlockCatalog([metadata, base]).textures.get(key).animation, baseAnimation);
  assert.deepEqual(new BlockCatalog([base, metadata]).textures.get(key).animation, overrideAnimation);
  assert.deepEqual(new BlockCatalog([base, metadata, replacement]).textures.get(key), { bytes: replacement.textures.get(key) });
  assert.deepEqual(new BlockCatalog([base, replacement, metadata]).textures.get(key), {
    bytes: replacement.textures.get(key), animation: overrideAnimation,
  });
});

test('animated texture frames use the Minecraft default and explicit frame sizes', () => {
  assert.equal(textureTimeline(undefined, 16, 48), null);
  for (const [metadata, imageSize, expected] of [
    [{}, [16, 48], [16, 16, 1, 3]],
    [{}, [48, 16], [16, 16, 3, 3]],
    [{ width: 8 }, [32, 16], [8, 16, 4, 4]],
    [{ height: 8 }, [16, 32], [16, 8, 1, 4]],
    [{ width: 8, height: 16 }, [16, 32], [8, 16, 2, 4]],
  ]) {
    const { width, height, columns, frameCount } = textureTimeline(metadata, ...imageSize);
    assert.deepEqual([width, height, columns, frameCount], expected);
  }
  const implicit = textureTimeline({ frametime: 2 }, 16, 48);
  assert.deepEqual(Array.from({ length: 7 }, (_, tick) => textureFrameAt(implicit, tick).index), [0, 0, 1, 1, 2, 2, 0]);
  assert.throws(() => textureTimeline({ width: 3 }, 16, 48), /帧尺寸/);
});

test('animated texture sequences keep per-frame durations and blend across a loop', () => {
  const metadata = {
    width: 8, height: 8, frametime: 2, interpolate: true,
    frames: [25, { index: 3, time: 4 }, 3, { index: 2, time: 0 }, 1, 0],
  };
  const timeline = textureTimeline(metadata, 16, 16);
  assert.equal(timeline.firstFrame, 3);
  assert.equal(timeline.duration, 10);
  assert.deepEqual(textureFrameAt(timeline, 2), { index: 3, next: 3, mix: 0 });
  assert.deepEqual(textureFrameAt(timeline, 5), { index: 3, next: 1, mix: 0.5 });
  assert.deepEqual(textureFrameAt(timeline, 6), { index: 1, next: 0, mix: 0 });
  assert.deepEqual(textureFrameAt(timeline, 9), { index: 0, next: 3, mix: 0.5 });
  assert.deepEqual(textureFrameAt(timeline, 10), textureFrameAt(timeline, 0));
  const still = textureTimeline({ ...metadata, frames: [2, 2, 2] }, 16, 16);
  assert.equal(still.animated, false);
  assert.deepEqual(textureFrameAt(still, 10), { index: 2, next: 2, mix: 0 });
});

test('modern inventory models use GUI inheritance and preserve the multipart block model in the scene', async () => {
  const face = { texture: '#surface' };
  const post = { from: [6, 0, 6], to: [10, 16, 10], faces: { up: face, south: face } };
  const rail = { from: [7, 6, 0], to: [9, 9, 6], faces: { up: face } };
  const gui = { rotation: [30, 135, 0], scale: [0.625, 0.625, 0.625] };
  const material = { sprite: 'example:block/panel', force_translucent: true };
  const catalog = new BlockCatalog([await loadArchive(archive({
    'assets/example/blockstates/panel.json': { multipart: [
      { apply: { model: 'example:block/post' } },
      { when: { east: 'true' }, apply: { model: 'example:block/rail', y: 90, uvlock: true } },
    ] },
    'assets/minecraft/models/block/block.json': { gui_light: 'side', display: { gui } },
    'assets/example/models/block/block.json': { gui_light: 'front' },
    'assets/example/models/block/post.json': { elements: [post], textures: { surface: material } },
    'assets/example/models/block/rail.json': { elements: [rail], textures: { surface: material } },
    'assets/example/textures/block/panel.png': '',
    'assets/example/models/block/panel_inventory.json': {
      parent: 'block/block', elements: [post, rail], textures: { surface: '#wood', wood: material }, display: { fixed: {} },
    },
    'assets/example/items/panel.json': { model: {
      type: 'minecraft:select', property: 'minecraft:display_context',
      cases: [{ when: ['gui', 'ground'], model: { type: 'minecraft:model', model: 'example:block/panel_inventory' } }],
      fallback: { type: 'minecraft:model', model: 'example:block/post' },
    } },
  }))]);

  const state = catalog.state({ name: 'example:panel', properties: { east: 'true' } });
  const [inventory] = catalog.itemParts(state);
  assert.equal(inventory.model.name, 'example:block/panel_inventory');
  assert.deepEqual(inventory.model.gui, gui);
  assert.equal(inventory.model.guiLight, 'side');
  const inventoryMesh = buildGeometry(catalog, inventory)[0];
  assert.equal(inventoryMesh.texture, 'example:block/panel');
  assert.equal(inventoryMesh.forceTranslucent, true);
  assert.equal(inventoryMesh.geometry.getIndex().count, 18);
  const inWorld = catalog.parts(state, [0, 0, 0]);
  assert.deepEqual(inWorld.map(part => [part.model.name, part.y]), [['example:block/post', 0], ['example:block/rail', 90]]);
});

test('legacy generated item models use sprite layers', async () => {
  const catalog = new BlockCatalog([await loadArchive(archive({
    'assets/example/models/item/panel.json': {
      parent: 'item/generated', textures: { layer0: 'example:item/panel', layer1: 'example:item/inlay' },
    },
    'assets/example/textures/item/panel.png': '',
    'assets/example/textures/item/inlay.png': '',
  }))]);
  const [inventory] = catalog.itemParts(catalog.state('example:panel'));
  assert.equal(inventory.model.generated, true);
  assert.equal(inventory.model.guiLight, 'front');
  assert.deepEqual(buildGeometry(catalog, inventory).map(batch => [batch.texture, batch.geometry.getIndex().count]), [
    ['example:item/panel', 12], ['example:item/inlay', 12],
  ]);
});

test('copper chests use the matching oxidation textures for single and double chests', async () => {
  const stages = {
    copper_chest: 'copper', exposed_copper_chest: 'copper_exposed',
    weathered_copper_chest: 'copper_weathered', oxidized_copper_chest: 'copper_oxidized',
  };
  const types = { single: '', left: '_left', right: '_right' };
  const assets = {};
  for (const [name, texture] of Object.entries(stages)) {
    for (const prefix of ['', 'waxed_']) {
      assets[`assets/minecraft/blockstates/${prefix}${name}.json`] = { variants: { '': { model: `minecraft:block/${name}` } } };
    }
    assets[`assets/minecraft/models/block/${name}.json`] = { textures: { particle: 'minecraft:block/copper_block' } };
    for (const suffix of Object.values(types)) assets[`assets/minecraft/textures/entity/chest/${texture}${suffix}.png`] = '';
  }

  const catalog = new BlockCatalog([await loadArchive(archive(assets))]);
  for (const [name, texture] of Object.entries(stages)) {
    for (const prefix of ['', 'waxed_']) {
      const id = `minecraft:${prefix}${name}`;
      assert.deepEqual(catalog.blocks.get(id).properties, {
        facing: ['north', 'east', 'south', 'west'], waterlogged: ['false', 'true'], type: ['single', 'left', 'right'],
      });
      for (const [type, suffix] of Object.entries(types)) {
        const state = catalog.state({ name: id, properties: { facing: 'east', type } });
        const [part] = catalog.parts(state, [0, 0, 0]);
        const [mesh] = buildGeometry(catalog, part);
        assert.equal(part.y, 270);
        assert.equal(mesh.texture, `minecraft:entity/chest/${texture}${suffix}`);
        mesh.geometry.dispose();
      }
    }
  }
});

test('cuboid baking supports Euler element rotations and rotates cropped UV coordinates under uvlock', () => {
  const catalog = new BlockCatalog();
  const texture = 'minecraft:block/stone';
  const patch = { from: [6, 8, 8], to: [10, 12, 12], faces: { up: { texture, uv: [2, 4, 6, 8] } } };
  const bake = (element, state) => buildGeometry(catalog, { model: { textures: {}, elements: [element] }, ...state })[0].geometry;
  const rotated = bake({ ...patch, rotation: { origin: [8, 8, 8], y: 90, z: 90 } });
  assert.deepEqual([...rotated.getAttribute('position').array.slice(0, 3)], [0.25, 0.5, 0.625]);
  const locked = bake(patch, { y: 90, uvlock: true });
  assert.deepEqual([...locked.getAttribute('uv').array], [0.75, 0.875, 0.5, 0.875, 0.5, 0.625, 0.75, 0.625]);
  const rotatedZ = bake(patch, { z: 90 });
  assert.deepEqual([...rotatedZ.getAttribute('position').array.slice(0, 3)], [0.75, 0.625, 0.5]);
});
