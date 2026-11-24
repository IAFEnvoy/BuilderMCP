import { gzipSync } from 'fflate';
import { readNbt, TAG } from './nbt.js';
import { boundsOf, cellKey, emptyProject, isAir, MAX_BLOCKS, point, stateKey, stateOf } from './scene.js';

const MAX_LITEMATIC_VOLUME = 16_000_000;
export const STRUCTURE_FORMATS = ['nbt', 'litematic'];

class NbtWriter {
  buffer = new ArrayBuffer(4096);
  view = new DataView(this.buffer);
  offset = 0;

  reserve(size) {
    const offset = this.offset;
    this.offset += size;
    if (this.offset > this.buffer.byteLength) {
      const buffer = new ArrayBuffer(Math.max(this.offset, this.buffer.byteLength * 2));
      new Uint8Array(buffer).set(new Uint8Array(this.buffer));
      this.buffer = buffer;
      this.view = new DataView(buffer);
    }
    return offset;
  }

  byte(value) { const offset = this.reserve(1); this.view.setUint8(offset, value); }
  short(value) { const offset = this.reserve(2); this.view.setUint16(offset, value); }
  int(value) { const offset = this.reserve(4); this.view.setInt32(offset, value); }
  long(value) { const offset = this.reserve(8); this.view.setBigInt64(offset, BigInt(value)); }

  string(value) {
    const bytes = [];
    // Java NBT uses modified UTF-8, including separate encodings for UTF-16 surrogates.
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c > 0 && c < 128) bytes.push(c);
      else if (c < 2048) bytes.push(192 | c >> 6, 128 | c & 63);
      else bytes.push(224 | c >> 12, 128 | c >> 6 & 63, 128 | c & 63);
    }
    if (bytes.length > 65535) throw new Error('NBT 字符串过长。');
    this.short(bytes.length);
    const offset = this.reserve(bytes.length);
    new Uint8Array(this.buffer, offset, bytes.length).set(bytes);
  }

  tag(type, name, value) {
    this.byte(TAG[type]);
    this.string(name);
    this[type](value);
  }

  compound(write) {
    write(this);
    this.byte(TAG.end);
  }

  list({ type, items }) {
    this.byte(TAG[type]);
    this.int(items.length);
    for (const item of items) this[type](item);
  }

  longs(words) {
    this.int(words.length / 2);
    for (let i = 0; i < words.length; i += 2) {
      this.int(words[i + 1]);
      this.int(words[i]);
    }
  }

  finish() { return gzipSync(new Uint8Array(this.buffer, 0, this.offset)); }
}

function paletteEntry(state) {
  return nbt => {
    nbt.tag('string', 'Name', state.name);
    if (state.properties) {
      nbt.tag('compound', 'Properties', properties => {
        for (const [key, value] of Object.entries(state.properties)) properties.tag('string', key, value);
      });
    }
  };
}

function writeVec(nbt, name, vector) {
  nbt.tag('compound', name, child => {
    for (const [i, axis] of ['x', 'y', 'z'].entries()) child.tag('int', axis, vector[i]);
  });
}

function writeEmptyLists(nbt, names) {
  for (const name of names) nbt.tag('list', name, { type: 'compound', items: [] });
}

export function encodeStructure(project, format, { preserveOrigin = false } = {}) {
  if (!STRUCTURE_FORMATS.includes(format)) throw new Error('未知结构格式。');
  const bounds = boundsOf(project.blocks) ?? { min: [0, 0, 0], max: [0, 0, 0] };
  const litematic = format === 'litematic';
  // Java structure positions are nonnegative. Litematica can store the region origin separately.
  const offset = preserveOrigin && !litematic ? bounds.min.map(n => Math.min(n, 0)) : bounds.min;
  const size = bounds.max.map((n, axis) => n - offset[axis] + 1);
  const [width, height, depth] = size;
  const volume = width * height * depth;
  if (litematic && volume > MAX_LITEMATIC_VOLUME) throw new Error('投影的包围盒超过 1600 万格。');

  const palette = litematic ? [{ name: 'minecraft:air' }] : [];
  const indices = new Map(palette.map((state, i) => [stateKey(state), i]));
  const blocks = [...project.blocks].sort((a, b) => a.pos[1] - b.pos[1] || a.pos[2] - b.pos[2] || a.pos[0] - b.pos[0]);
  const relative = blocks.map(({ pos, state }) => {
    const key = stateKey(state);
    if (!indices.has(key)) {
      indices.set(key, palette.length);
      palette.push(state);
    }
    return { pos: pos.map((n, i) => n - offset[i]), index: indices.get(key) };
  });

  const writer = new NbtWriter();
  writer.tag('compound', '', nbt => {
    if (!litematic) {
      nbt.tag('int', 'DataVersion', project.dataVersion);
      nbt.tag('list', 'size', { type: 'int', items: size });
      nbt.tag('list', 'palette', { type: 'compound', items: palette.map(paletteEntry) });
      nbt.tag('list', 'blocks', {
        type: 'compound', items: relative.map(({ pos, index }) => block => {
          block.tag('list', 'pos', { type: 'int', items: pos });
          block.tag('int', 'state', index);
        }),
      });
      writeEmptyLists(nbt, ['entities']);
      return;
    }

    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const words = new Uint32Array(Math.ceil(volume * bits / 64) * 2);
    for (const { pos: [x, y, z], index } of relative) {
      const bit = ((y * depth + z) * width + x) * bits;
      const word = Math.floor(bit / 32);
      const shift = bit % 32;
      words[word] |= index << shift;
      if (shift + bits > 32) words[word + 1] |= index >>> (32 - shift);
    }
    nbt.tag('int', 'Version', 6);
    nbt.tag('int', 'SubVersion', 1);
    nbt.tag('int', 'MinecraftDataVersion', project.dataVersion);
    nbt.tag('compound', 'Metadata', meta => {
      const now = Date.now();
      meta.tag('string', 'Name', project.name);
      meta.tag('string', 'Author', 'Builder MCP');
      meta.tag('string', 'Description', '');
      meta.tag('long', 'TimeCreated', now);
      meta.tag('long', 'TimeModified', now);
      meta.tag('int', 'RegionCount', 1);
      meta.tag('int', 'TotalBlocks', blocks.length);
      meta.tag('int', 'TotalVolume', volume);
      writeVec(meta, 'EnclosingSize', size);
    });
    nbt.tag('compound', 'Regions', regions => {
      regions.tag('compound', 'Main', region => {
        writeVec(region, 'Position', preserveOrigin ? bounds.min : [0, 0, 0]);
        writeVec(region, 'Size', size);
        region.tag('list', 'BlockStatePalette', { type: 'compound', items: palette.map(paletteEntry) });
        region.tag('longs', 'BlockStates', words);
        writeEmptyLists(region, ['Entities', 'TileEntities', 'PendingBlockTicks', 'PendingFluidTicks']);
      });
    });
  });
  return writer.finish();
}

const isCompound = value => value != null && Object.getPrototypeOf(value) === null;
const isVector = value => Array.isArray(value) && value.length === 3 && value.every(Number.isInteger);

function readPalette(list) {
  if (!Array.isArray(list)) throw new Error('结构文件缺少有效的方块调色板。');
  return list.map(entry => {
    if (!isCompound(entry) || (entry.Properties !== undefined && !isCompound(entry.Properties))) {
      throw new Error('方块调色板包含无效的状态。');
    }
    return stateOf({ name: entry.Name, properties: entry.Properties });
  });
}

function addBlock(blocks, pos, state) {
  point(pos, '导入方块的坐标');
  blocks.set(cellKey(pos), { pos, state });
  if (blocks.size > MAX_BLOCKS) throw new Error('结构的方块数量超过编辑器上限。');
}

function readJavaBlocks(root, blocks) {
  const { size, blocks: entries } = root;
  if (!isVector(size) || size.some(n => n < 0) || !Array.isArray(entries)) {
    throw new Error('文件不是有效的 Minecraft Java 版原版结构。');
  }
  const palette = readPalette(root.palette ?? root.palettes?.[0]);
  for (const entry of entries) {
    const pos = entry?.pos;
    const index = entry?.state;
    if (!isVector(pos) || pos.some((n, axis) => n < 0 || n >= size[axis])) {
      throw new Error('结构中有方块的坐标超出文件声明的尺寸。');
    }
    if (!Number.isInteger(index) || !palette[index]) throw new Error('结构引用了无效的方块索引。');
    const state = palette[index];
    if (!isAir(state.name)) addBlock(blocks, pos, state);
  }
}

function regionVector(value) {
  const result = [value?.x, value?.y, value?.z];
  if (!isVector(result)) throw new Error('Litematica 区域的坐标或尺寸无效。');
  return result;
}

function packedIndex(words, bit, bits, mask) {
  const word = Math.floor(bit / 32);
  const shift = bit % 32;
  // Each NBT long stores its high 32 bits first, while packing starts in the low bits.
  const low = words.getUint32((word ^ 1) * 4) >>> shift;
  if (shift + bits <= 32) return low & mask;
  const high = words.getUint32(((word + 1) ^ 1) * 4) << (32 - shift);
  return (low | high) & mask;
}

function readLitematicBlocks(root, blocks) {
  if (!isCompound(root.Regions)) throw new Error('文件缺少 Litematica 区域。');
  let totalVolume = 0;
  for (const region of Object.values(root.Regions)) {
    const position = regionVector(region?.Position);
    const size = regionVector(region?.Size);
    const min = position.map((n, axis) => size[axis] < 0 ? n + size[axis] + 1 : n);
    const [width, height, depth] = size.map(Math.abs);
    const layerSize = width * depth;
    const volume = layerSize * height;
    totalVolume += volume;
    if (!volume) throw new Error('Litematica 区域的尺寸不能为 0。');
    if (totalVolume > MAX_LITEMATIC_VOLUME) throw new Error('投影的区域总体积超过 1600 万格。');

    const palette = readPalette(region.BlockStatePalette);
    if (!palette.length) throw new Error('Litematica 区域的方块调色板为空。');
    const bits = Math.max(2, Math.ceil(Math.log2(palette.length)));
    const mask = (1 << bits) - 1;
    const words = region.BlockStates;
    if (!(words instanceof DataView) || words.byteLength !== Math.ceil(volume * bits / 64) * 8) {
      throw new Error('Litematica 区域的方块数据长度与调色板或尺寸不匹配。');
    }
    for (let i = 0; i < volume; i++) {
      const state = palette[packedIndex(words, i * bits, bits, mask)];
      if (!state) throw new Error('投影引用了无效的方块索引。');
      if (isAir(state.name)) continue;
      const pos = [min[0] + i % width, min[1] + Math.floor(i / layerSize), min[2] + Math.floor(i / width) % depth];
      addBlock(blocks, pos, state);
    }
  }
}

export async function decodeStructure(bytes, format, filename) {
  if (!STRUCTURE_FORMATS.includes(format)) throw new Error('未知结构格式。');
  const root = await readNbt(bytes);
  const litematic = format === 'litematic';
  const dataVersion = litematic ? root.MinecraftDataVersion : root.DataVersion;
  if (dataVersion !== undefined && (!Number.isInteger(dataVersion) || dataVersion > 2_147_483_647)) {
    throw new Error('结构文件中的 DataVersion 无效。');
  }
  const blocks = new Map();
  if (litematic) readLitematicBlocks(root, blocks);
  else readJavaBlocks(root, blocks);

  const project = emptyProject(dataVersion > 0 ? dataVersion : undefined);
  const label = litematic && typeof root.Metadata?.Name === 'string' ? root.Metadata.Name.trim() : '';
  project.name = (label || filename?.trim() || project.name).slice(0, 120).replace(/[\uD800-\uDBFF]$/, '').trim() || project.name;
  project.blocks = [...blocks.values()];
  return project;
}
