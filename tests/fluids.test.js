import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildGeometry } from '../src/model-geometry.js';
import { BlockCatalog } from '../src/resource-pack.js';
import { cellKey } from '../src/scene.js';

const water = 'minecraft:water';
const lava = 'minecraft:lava';
const texture = name => `minecraft:block/${name}`;
const waterStill = texture('water_still');
const waterFlow = texture('water_flow');
const waterOverlay = texture('water_overlay');
const slab = 'minecraft:stone_slab';
const stone = 'minecraft:stone';
const glass = 'minecraft:glass';
const cuboid = (from, to) => ({
  from, to, faces: Object.fromEntries(['up', 'down', 'north', 'south', 'east', 'west'].map(direction =>
    [direction, { texture: 'block/stone', cullface: direction }])),
});

function packWithFluids() {
  return {
    states: new Map([
      [water, { variants: { '': { model: texture('water') } } }],
      [lava, { variants: { '': { model: texture('lava') } } }],
      [slab, { variants: { 'type=bottom': { model: texture('bottom_slab') }, 'type=top': { model: texture('top_slab') } } }],
    ]),
    models: new Map([
      [texture('water'), { textures: { particle: waterStill } }],
      [texture('lava'), { textures: { particle: texture('lava_still') } }],
      [texture('stone'), { elements: [cuboid([0, 0, 0], [16, 16, 16])] }],
      [texture('glass'), { elements: [cuboid([0, 0, 0], [16, 16, 16])] }],
      [texture('bottom_slab'), { elements: [cuboid([0, 0, 0], [16, 8, 16])] }],
      [texture('top_slab'), { elements: [cuboid([0, 8, 0], [16, 16, 16])] }],
    ]),
    textures: new Map([waterStill, waterFlow, waterOverlay, texture('lava_still'), texture('lava_flow'), texture('stone')]
      .map(name => [name, new Uint8Array()])),
    animation: new Map(), languages: new Map(),
  };
}

const liquid = (catalog, pos, state, blockAt) => catalog.parts(catalog.state(state), pos, undefined, blockAt).find(part => part.fluid);

test('particle-only water and lava render at their state height with the pack sprites', () => {
  const pack = packWithFluids();
  const stillOverride = texture('custom_water');
  pack.models.get(texture('water')).textures.particle = stillOverride;
  pack.textures.set(stillOverride, new Uint8Array());
  const catalog = new BlockCatalog([pack]);
  assert.equal(catalog.state(water).properties.level, '0');
  assert.deepEqual(catalog.stateProperties(water).level, Array.from({ length: 16 }, (_, level) => String(level)));

  const origin = [0, 0, 0];
  const source = liquid(catalog, origin, water);
  const shallow = liquid(catalog, origin, { name: water, properties: { level: '7' } });
  const falling = liquid(catalog, origin, { name: water, properties: { level: '8' } });
  const legacy = liquid(catalog, origin, { name: water, properties: { liquid_depth: '7' } });
  assert.ok(source.fluid.heights[0] < 1);
  assert.ok(shallow.fluid.heights[0] < source.fluid.heights[0]);
  assert.equal(falling.key, source.key);
  assert.equal(legacy.key, shallow.key);

  const waterMeshes = buildGeometry(catalog, source);
  const lavaMeshes = buildGeometry(catalog, liquid(catalog, origin, lava));
  assert.ok(waterMeshes.some(mesh => mesh.texture === stillOverride));
  assert.ok(waterMeshes.some(mesh => mesh.texture === waterFlow));
  assert.ok(waterMeshes.every(mesh => mesh.forceTranslucent));
  assert.ok(lavaMeshes.every(mesh => !mesh.forceTranslucent));
  for (const { geometry } of [...waterMeshes, ...lavaMeshes]) geometry.dispose();
});

test('neighboring liquids share corner heights and cull faces against liquid or solid cells', () => {
  const catalog = new BlockCatalog([packWithFluids()]);
  const blocks = new Map();
  const set = (pos, state) => blocks.set(cellKey(pos), { pos, state: catalog.state(state) });
  const blockAt = (...pos) => blocks.get(cellKey(pos));
  const [left, right] = [[15, 0, 0], [16, 0, 0]];
  set(left, water);
  set(right, { name: water, properties: { level: '4' } });
  set([15, -1, 0], stone);
  set([15, 0, -1], glass);
  const leftFluid = liquid(catalog, left, water, blockAt).fluid;
  const rightFluid = liquid(catalog, right, blockAt(...right).state, blockAt).fluid;
  assert.ok(Math.abs(leftFluid.heights[3] - rightFluid.heights[0]) < 1e-6);
  assert.ok(Math.abs(leftFluid.heights[2] - rightFluid.heights[1]) < 1e-6);
  assert.equal(leftFluid.faces.find(face => face.direction === 'up')?.texture, waterFlow);
  assert.equal(leftFluid.faces.find(face => face.direction === 'north')?.texture, waterOverlay);
  assert.ok(!leftFluid.faces.some(face => ['east', 'down'].includes(face.direction)));
  assert.ok(!rightFluid.faces.some(face => face.direction === 'west'));

  set([15, 1, 0], water);
  const stacked = liquid(catalog, left, water, blockAt).fluid;
  assert.deepEqual(stacked.heights, [1, 1, 1, 1]);
  assert.ok(!stacked.faces.some(face => face.direction === 'up'));
  set(right, lava);
  assert.ok(liquid(catalog, left, water, blockAt).fluid.faces.some(face => face.direction === 'east'));

  for (const pos of [right, [14, 0, 0], [15, -1, 0], [15, 0, -1], [15, 0, 1]]) set(pos, water);
  assert.equal(liquid(catalog, left, water, blockAt), undefined);
});

test('waterlogged models keep their solid geometry and mod liquids are recognized from texture pairs', () => {
  const pack = packWithFluids();
  const syrup = 'example:syrup';
  const still = 'example:fluid/syrup_still';
  const flow = 'example:fluid/syrup_flow';
  pack.states.set(syrup, { variants: { '': { model: 'example:block/syrup' } } });
  pack.models.set('example:block/syrup', { textures: { particle: still } });
  pack.textures.set(still, new Uint8Array());
  const origin = [0, 0, 0];
  assert.equal(liquid(new BlockCatalog([pack]), origin, syrup), undefined);
  pack.textures.set(flow, new Uint8Array());
  const catalog = new BlockCatalog([pack]);
  assert.equal(liquid(catalog, origin, syrup).fluid.faces.find(face => face.direction === 'south')?.texture, flow);

  const bottom = { name: slab, properties: { type: 'bottom', waterlogged: 'true' } };
  const top = { name: slab, properties: { ...bottom.properties, type: 'top' } };
  assert.equal(catalog.parts(bottom, origin).length, 2);
  assert.ok(!liquid(catalog, origin, bottom).fluid.faces.some(face => face.direction === 'down'));
  assert.ok(!liquid(catalog, origin, top).fluid.faces.some(face => face.direction === 'up'));
  assert.equal(liquid(catalog, origin, { name: slab, properties: { type: 'bottom', waterlogged: 'false' } }), undefined);
  const bubbleColumn = catalog.parts(catalog.state('minecraft:bubble_column'), origin);
  assert.equal(bubbleColumn.length, 1);
  assert.equal(bubbleColumn[0].fluid.type, water);
});
