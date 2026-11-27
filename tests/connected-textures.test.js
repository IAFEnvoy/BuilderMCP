import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectFaces, connectedTile, inferStripLayout } from '../src/connected-textures.js';
import { buildGeometry, connectedModelFaces } from '../src/model-geometry.js';
import { BlockCatalog } from '../src/resource-pack.js';

function stripPixels(horizontal, tiles) {
  const size = 8;
  const width = 2 * size;
  const data = new Uint8ClampedArray(width * width * 4);
  for (const [connections, tile] of tiles.entries()) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const band = horizontal ? x : size - y - 1;
        const border = band === size - 1 && !(connections & 1) || band === 0 && !(connections & 2);
        const px = x + (tile % 2) * size;
        const py = y + Math.floor(tile / 2) * size;
        data[(py * width + px) * 4 + 3] = border ? 255 : 0;
      }
    }
  }
  return { width, data };
}

test('2×2 atlases use their pixel borders to distinguish vertical, horizontal and reordered strips', () => {
  for (const [horizontal, tiles] of [
    [true, [0, 1, 2, 3]], [true, [0, 2, 1, 3]], [true, [0, 2, 3, 1]], [false, [0, 1, 2, 3]],
  ]) {
    const layout = inferStripLayout(stripPixels(horizontal, tiles));
    assert.deepEqual(layout, { horizontal, tiles });
    assert.equal(connectedTile({ size: 2, strip: layout }, horizontal ? { right: true } : { up: true }), tiles[1]);
  }
  assert.equal(inferStripLayout({ width: 16, data: new Uint8ClampedArray(16 * 16 * 4) }), null);
});

test('Create tile indices keep outside edges and distinguish inside corners', () => {
  const omni = { size: 8 };
  assert.equal(connectedTile(omni, {}), 0);
  assert.equal(connectedTile(omni, { up: true, right: true }), 17);
  assert.equal(connectedTile(omni, { up: true, right: true, topRight: true }), 20);
  assert.equal(connectedTile(omni, { up: true, down: true, left: true, topLeft: true, bottomLeft: true }), 34);
  assert.equal(connectedTile({ size: 4 }, {}), 12);
  assert.equal(connectedTile({ size: 4 }, { up: true, right: true }), 9);
  assert.equal(connectedTile({ size: 4, roof: true }, {}, { facing: 'south', shape: 'inner_left', half: 'bottom' }), 15);
});

function pngHeader(size) {
  const bytes = new Uint8Array(24);
  const header = new DataView(bytes.buffer);
  header.setUint32(0, 0x89504e47);
  header.setUint32(12, 0x49484452);
  header.setUint32(16, size);
  header.setUint32(20, size);
  return bytes;
}

test('models in any namespace choose connected sheets by face and remap rotated UVs', () => {
  const base = 'example:block/palette/panel';
  const omni = base + '_connected';
  const horizontal = 'example:block/palette/horizontal_panel_connected';
  const model = {
    name: 'example:block/horizontal_panel',
    textures: { all: { texture: base } },
    elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {
      south: { texture: '#all', cullface: 'south', rotation: 180 },
      up: { texture: '#all', cullface: 'up' },
    } }],
  };
  const pack = {
    states: new Map(), models: new Map(), animation: new Map(), languages: new Map(),
    textures: new Map([[base, pngHeader(16)], [omni, pngHeader(128)], [horizontal, pngHeader(32)]]),
    connectedSheets: new Map([
      [omni, { width: 128, height: 128 }],
      [horizontal, { width: 32, height: 32, strip: { horizontal: true, tiles: [0, 2, 3, 1] } }],
    ]),
  };
  const higher = { ...pack, connectedSheets: new Map(), textures: new Map([[base, pngHeader(32)]]) };
  const catalog = new BlockCatalog([pack, higher]);
  const part = { model, y: 90 };
  const faces = connectedModelFaces(catalog, part);
  const side = faces.find(face => face.normal[0] === -1);
  const top = faces.find(face => face.normal[1] === 1);
  assert.deepEqual(side.horizontal.map(n => n || 0), [0, 0, -1]);
  assert.equal(side.sheet.texture, horizontal);
  assert.equal(top.sheet.texture, omni);

  const state = { name: 'example:panel' };
  const neighbor = (x, y, z) => x === 0 && y === 0 && z === -1 ? { state } : undefined;
  const { patches } = connectFaces(faces, state, {}, [0, 0, 0], neighbor);
  assert.equal(patches.get(side.key).tile, 2);
  const geometry = buildGeometry(catalog, part, undefined, false, patches);
  const sideUvs = geometry.find(batch => batch.texture === horizontal).geometry.getAttribute('uv');
  assert.deepEqual([sideUvs.getX(0), sideUvs.getY(0), sideUvs.getX(2), sideUvs.getY(2)], [31 / 64, 1 / 64, 1 / 64, 31 / 64]);
  for (const batch of geometry) batch.geometry.dispose();

  const occluded = (x, y, z) => x === -1 && y === 0 && z === 0 ? { state } : undefined;
  assert.equal(connectFaces(faces, state, {}, [0, 0, 0], occluded).patches.get(side.key), false);
});
