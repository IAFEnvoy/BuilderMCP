/*!
 * Tile layout rules adapted from Create's AllCTTypes (MIT).
 * Copyright (c) The Create Team / The Creators of Create
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { decodeTexture } from './texture-animation.js';
import { cellKey } from './scene.js';

const suffix = '_connected';
const pngHeader = 0x89504e47;
const sizes = new Set([2, 4, 8]);

function pngSize(bytes) {
  if (!bytes || bytes.length < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== pngHeader || view.getUint32(12) !== 0x49484452) return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width && height ? { width, height } : null;
}

// Group the four tiles by which edge they preserve. Create has both ascending
// and reordered strip sheets, and some horizontal sheets mirror the edges.
const stripLayouts = [
  { tiles: [0, 1, 2, 3], horizontal: true },
  { tiles: [0, 2, 1, 3], horizontal: true },
  { tiles: [0, 2, 3, 1], horizontal: true },
  { tiles: [0, 1, 2, 3], horizontal: false },
  { tiles: [0, 2, 1, 3], horizontal: false },
];

export function inferStripLayout({ width, data }) {
  const tileWidth = width / 2;
  const thickness = Math.max(1, Math.ceil(tileWidth / 8));
  const error = (a, b, side) => {
    let total = 0;
    const horizontal = side < 2;
    const last = side % 2;
    for (let inward = 0; inward < thickness; inward++) {
      const edge = last ? tileWidth - inward - 1 : inward;
      for (let across = 0; across < tileWidth; across++) {
        const x = horizontal ? edge : across;
        const y = horizontal ? across : edge;
        const offset = (y * width + x) * 4;
        const first = offset + ((a >> 1) * width + (a & 1)) * tileWidth * 4;
        const second = offset + ((b >> 1) * width + (b & 1)) * tileWidth * 4;
        const alpha = data[first + 3];
        const otherAlpha = data[second + 3];
        total += Math.abs(alpha - otherAlpha);
        for (let i = 0; i < 3; i++) total += Math.abs(data[first + i] * alpha - data[second + i] * otherAlpha) / 255;
      }
    }
    return total;
  };
  const edgeScore = (side, a, b, c, d) => (
    (error(a, c, side) + error(b, d, side) + error(a, d, side) + error(b, c, side)) / 2
    - error(a, b, side) - error(c, d, side)
  );
  let best = null;
  let bestScore = 0;
  for (const layout of stripLayouts) {
    const [none, positive, negative, both] = layout.tiles;
    const [first, second] = layout.horizontal ? [positive, negative] : [negative, positive];
    const start = layout.horizontal ? 0 : 2;
    const score = edgeScore(start, none, first, second, both) + edgeScore(start + 1, none, second, first, both);
    if (score > bestScore) {
      best = layout;
      bestScore = score;
    }
  }
  return best;
}

export async function readConnectedSheet(bytes) {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
  const size = pngSize(bytes);
  if (!size || size.width !== size.height || size.width % 2) return null;
  try {
    const { image } = await decodeTexture(bytes);
    try {
      const pixels = image.getContext('2d').getImageData(0, 0, size.width, size.height);
      return { ...size, strip: inferStripLayout(pixels) };
    } finally {
      image.width = 0;
    }
  } catch {
    return null;
  }
}

function connectedSheet(catalog, texture, base, roof = false) {
  const id = texture + suffix;
  const sheet = catalog.connectedSheets.get(id);
  if (!sheet || catalog.textures.get(id)?.animation) return null;
  const dimensions = pngSize(sheet.textures?.get(base) ?? catalog.textures.get(base)?.bytes);
  if (!dimensions) return null;
  const size = sheet.width / dimensions.width;
  if (!sizes.has(size) || sheet.height / dimensions.height !== size) return null;
  if (size === 2 && !sheet.strip) return null;
  return { texture: id, size, width: sheet.width, height: sheet.height, strip: sheet.strip, roof };
}

export function sheetForFace(catalog, model, base, normal, pane) {
  if (typeof base !== 'string') return null;
  const slash = base.lastIndexOf('/');
  const directory = base.slice(0, slash + 1);
  const filename = base.slice(slash + 1);
  const modelName = model.name?.split('/').at(-1)?.replace(/_pane_(?:post|side|noside)(?:_alt)?$/, '');
  const directional = modelName === 'horizontal_' + filename || modelName === 'vertical_' + filename;
  const numbered = modelName?.replace(/_\d+$/, '') === filename && modelName !== filename;
  if (directional || numbered) {
    const sheet = connectedSheet(catalog, directory + modelName, base);
    if (sheet && (normal[1] === 0 || pane)) return sheet;
    if (sheet && (numbered || modelName.startsWith('vertical_'))) return null;
  }

  const roof = /^(.*)_roof_top$/.exec(filename);
  if (roof && normal[1] === 1) {
    for (const slot of Object.keys(model.textures)) {
      const other = catalog.textureMaterial(model, '#' + slot)?.texture;
      if (typeof other !== 'string' || other === base || !other.startsWith(directory + roof[1] + '_')) continue;
      const sheet = connectedSheet(catalog, other + '_top', base, true);
      if (sheet?.size === 4) return sheet;
    }
  }
  const direct = connectedSheet(catalog, base, base);
  if (direct || !pane) return direct;
  // Some panes use the same numbered sheets as their full-block models.
  for (const id of catalog.connectedSheets.keys()) {
    if (!id.startsWith(base + '_')) continue;
    if (!/^\d+_connected$/.test(id.slice(base.length + 1))) continue;
    const sheet = connectedSheet(catalog, id.slice(0, -suffix.length), base);
    if (sheet?.size === 4) return sheet;
  }
  return null;
}

function omniTile({
  up = false, down = false, left = false, right = false,
  topLeft = false, topRight = false, bottomLeft = false, bottomRight = false,
}) {
  // Create uses a 47-tile layout. Corners only count when both of their edges connect.
  const column = Number(up) + 2 * Number(down);
  const row = Number(left) + 2 * Number(right);
  const edges = Number(up) + Number(down) + Number(left) + Number(right);
  if (edges === 4) {
    return column + Number(topRight) + 2 * Number(topLeft) + 8 * (row + Number(bottomLeft) + 2 * Number(bottomRight));
  }
  if (edges === 3) {
    const [edgeRow, innerCorners] = !right ? [4, Number(bottomLeft) + 2 * Number(topLeft)]
      : !left ? [5, Number(bottomRight) + 2 * Number(topRight)]
      : !down ? [6, Number(topLeft) + 2 * Number(topRight)]
      : [7, Number(bottomLeft) + 2 * Number(bottomRight)];
    if (innerCorners) return 8 * edgeRow + innerCorners - 1;
  }
  const corner = topLeft || topRight || bottomLeft || bottomRight;
  return column + (edges === 2 && corner ? 3 : 0) + 8 * row;
}

const roofStairs = {
  straight: [1, 6, 9, 4],
  inner: [14, 12, 13, 15],
  outer: [2, 10, 8, 0],
};
const roofCorners = { 6: 7, 7: 12, 9: 11, 11: 13, 13: 14, 14: 15 };

function roofTile({
  up, down, left, right, topLeft = false, topRight = false, bottomLeft = false, bottomRight = false,
}, properties) {
  const { shape, facing, half } = properties;
  const [turn, side] = typeof shape === 'string' ? shape.split('_') : [];
  const stair = Object.hasOwn(roofStairs, turn) && roofStairs[turn];
  const direction = ['south', 'west', 'north', 'east'].indexOf(facing);
  if (stair && direction >= 0 && half === 'bottom') return stair[(direction + (side === 'left' ? 3 : 0)) % 4];

  if (up && down && left && right) {
    const corners = Number(topLeft) + 2 * Number(topRight) + 4 * Number(bottomLeft) + 8 * Number(bottomRight);
    return roofCorners[corners] ?? 5;
  }
  if (!up && down && (left || right)) {
    return left && right ? 1 : left ? (bottomLeft ? 2 : 5) : (bottomRight ? 0 : 5);
  }
  if (up && !down && (left || right)) {
    return left && right ? 9 : left ? (topLeft ? 10 : 5) : (topRight ? 8 : 5);
  }
  if (up || down) {
    if (!left && right) return 4;
    if (left && !right) return 6;
  }
  return 5;
}

export function connectedTile(sheet, context, properties) {
  const { up = false, down = false, left = false, right = false } = context;
  if (sheet.size === 2) {
    const { horizontal, tiles } = sheet.strip;
    return tiles[horizontal ? Number(right) + 2 * Number(left) : Number(up) + 2 * Number(down)];
  }
  if (sheet.size === 8) return omniTile(context);
  if (sheet.roof) return roofTile(context, properties ?? {});
  const column = left ? (right ? 2 : 3) : Number(right);
  const row = up ? (down ? 1 : 2) : (down ? 0 : 3);
  return column + 4 * row;
}

const connectionProperties = ['axis', 'type', 'half', 'open'];

export function connectFaces(faces, state, defaults, pos, blockAt) {
  const properties = { ...defaults, ...state.properties };
  const patches = new Map();
  const signature = [];
  const neighbors = new Map();
  const matches = (x, y, z) => {
    const key = cellKey([x, y, z]);
    if (neighbors.has(key)) return neighbors.get(key);
    const other = blockAt(pos[0] + x, pos[1] + y, pos[2] + z)?.state;
    const value = name => other.properties?.[name] ?? defaults?.[name];
    const match = other?.name === state.name &&
      connectionProperties.every(name => properties[name] === value(name)) &&
      (properties.open !== 'true' || properties.facing === value('facing'));
    neighbors.set(key, match);
    return match;
  };
  for (const { key, sheet, normal, horizontal, vertical, cull } of faces) {
    if (cull && matches(...normal)) {
      patches.set(key, false);
      signature.push('x');
      continue;
    }
    if (!sheet) {
      signature.push('');
      continue;
    }
    const connected = (h, v) => {
      const x = horizontal[0] * h + vertical[0] * v;
      const y = horizontal[1] * h + vertical[1] * v;
      const z = horizontal[2] * h + vertical[2] * v;
      return matches(x, y, z) && (!cull || !matches(x + normal[0], y + normal[1], z + normal[2]));
    };
    const up = connected(0, 1);
    const down = connected(0, -1);
    const left = connected(-1, 0);
    const right = connected(1, 0);
    const corners = sheet.size === 8 || sheet.roof;
    const tile = connectedTile(sheet, {
      up, down, left, right,
      topLeft: corners && up && left && connected(-1, 1),
      topRight: corners && up && right && connected(1, 1),
      bottomLeft: corners && down && left && connected(-1, -1),
      bottomRight: corners && down && right && connected(1, -1),
    }, properties);
    patches.set(key, { sheet, tile });
    signature.push(tile);
  }
  return { patches, key: signature.join(',') };
}
