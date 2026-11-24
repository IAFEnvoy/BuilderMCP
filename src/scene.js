export const DEFAULT_DATA_VERSION = 3955; // Java Edition 1.21.1
export const MAX_BLOCKS = 200_000;
export const MAX_COORDINATE = 1_000_000;
const MAX_FILL_VOLUME = 2_000_000;
const MAX_HISTORY_CHANGES = 500_000;
const resourceId = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const propertyName = /^[a-z0-9_]+$/;
const propertyValue = /^[a-z0-9_.-]+$/;
const air = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air']);
export const isAir = name => air.has(name);
const horizontal = ['north', 'east', 'south', 'west'];

export function emptyProject(dataVersion = DEFAULT_DATA_VERSION) {
  return { version: 1, name: '未命名建筑', dataVersion, blocks: [] };
}

export function point(value, label = '坐标') {
  if (!Array.isArray(value) || value.length !== 3 || value.some(n => !Number.isInteger(n) || Math.abs(n) > MAX_COORDINATE)) {
    throw new Error(`${label}需要三个整数，每项在 ±${MAX_COORDINATE} 以内。`);
  }
  return value;
}

export const cellKey = ([x, y, z]) => `${x},${y},${z}`;
export const samePoint = (a, b) => a.every((n, i) => n === b[i]);

export function stateOf(input) {
  if (typeof input === 'string') input = { name: input };
  if (typeof input?.name !== 'string') throw new Error('方块需要一个资源 ID。');
  const name = input.name.includes(':') ? input.name : `minecraft:${input.name}`;
  if (!resourceId.test(name) || name.length > 256) throw new Error(`无效的方块 ID：${name}`);

  const properties = input.properties ?? {};
  if (typeof properties !== 'object' || Array.isArray(properties)) throw new Error('方块状态需要键值对象。');
  const entries = Object.entries(properties).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length > 32) throw new Error('方块状态最多包含 32 个属性。');
  for (const [key, value] of entries) {
    if (!propertyName.test(key) || key.length > 64 || typeof value !== 'string' || !propertyValue.test(value) || value.length > 64) {
      throw new Error(`无效的方块状态属性：${key}`);
    }
  }
  return entries.length ? { name, properties: Object.fromEntries(entries) } : { name };
}

export function stateKey({ name, properties }) {
  return properties ? `${name}[${Object.entries(properties).map(pair => pair.join('=')).join(',')}]` : name;
}

export function boxBetween(a, b) {
  const min = a.map((n, i) => Math.min(n, b[i]));
  const max = a.map((n, i) => Math.max(n, b[i]));
  return { min, max, size: min.map((n, i) => max[i] - n + 1) };
}

export function boundsOf(blocks) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const { pos } of blocks) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], pos[i]);
      max[i] = Math.max(max[i], pos[i]);
    }
  }
  return Number.isFinite(min[0]) ? boxBetween(min, max) : null;
}

export const inBox = (pos, { min, max }) => pos.every((n, i) => n >= min[i] && n <= max[i]);

function rotateState(state, turns) {
  if (!state.properties || !turns) return state;
  const rotate = value => {
    const index = horizontal.indexOf(value);
    return index < 0 ? value : horizontal[(index + turns) % 4];
  };
  const properties = {};
  for (const [key, value] of Object.entries(state.properties)) {
    let next = value;
    if (key === 'facing') next = rotate(value);
    if (key === 'axis' && turns % 2 && ['x', 'z'].includes(value)) next = value === 'x' ? 'z' : 'x';
    if (key === 'rotation' && /^(?:[0-9]|1[0-5])$/.test(value)) next = String((Number(value) + turns * 4) % 16);
    if (key === 'orientation') next = value.split('_').map(rotate).join('_');
    if (key === 'shape') {
      const [first, second] = value.split('_');
      if (['north_south', 'east_west'].includes(value) && turns % 2) next = value === 'north_south' ? 'east_west' : 'north_south';
      if (first === 'ascending') next = `ascending_${rotate(second)}`;
      if (['north_east', 'north_west', 'south_east', 'south_west'].includes(value)) {
        next = [rotate(first), rotate(second)].sort((a, b) => Number(['east', 'west'].includes(a)) - Number(['east', 'west'].includes(b))).join('_');
      }
    }
    properties[rotate(key)] = next;
  }
  return stateOf({ name: state.name, properties });
}

function projectMetadata(name, dataVersion) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new Error('项目名称需要 1 至 120 个字符。');
  if (!Number.isInteger(dataVersion) || dataVersion < 1 || dataVersion > 2_147_483_647) throw new Error('DataVersion 必须是正整数。');
  return { name: name.trim(), dataVersion };
}

export class BuildScene {
  blocks = new Map();
  selection = new Set();
  listeners = new Set();
  history = [];
  future = [];
  revision = 0;
  lastRevision = 0;

  constructor(project) {
    this.load(project);
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(change) {
    for (const listener of this.listeners) listener(change);
  }

  load({ version, name, dataVersion, blocks }) {
    if (version !== 1 || !Array.isArray(blocks) || blocks.length > MAX_BLOCKS) throw new Error('项目格式不受支持，或方块数量超过上限。');
    const metadata = projectMetadata(name, dataVersion);
    const loaded = new Map();
    for (const input of blocks) {
      const pos = [...point(input?.pos)];
      const state = stateOf(input?.state);
      if (!isAir(state.name)) loaded.set(cellKey(pos), { pos, state });
    }
    this.blocks = loaded;
    Object.assign(this, metadata);
    this.selection = new Set();
    this.history = [];
    this.future = [];
    this.revision = ++this.lastRevision;
    this.notify({ reset: true });
  }

  snapshot() {
    return { version: 1, name: this.name, dataVersion: this.dataVersion, blocks: [...this.blocks.values()] };
  }

  get bounds() { return boundsOf(this.blocks.values()); }
  get selected() { return [...this.selection].map(key => this.blocks.get(key)).filter(Boolean); }

  select(keys) {
    this.selection = new Set([...keys].filter(key => this.blocks.has(key)));
    this.notify({ selection: true });
    return this.selection.size;
  }

  selectBox(a, b) {
    const box = boxBetween(point(a), point(b));
    const keys = [];
    for (const [key, { pos }] of this.blocks) if (inBox(pos, box)) keys.push(key);
    return this.select(keys);
  }

  setMetadata(name, dataVersion) {
    const after = projectMetadata(name, dataVersion);
    if (after.name === this.name && after.dataVersion === this.dataVersion) return;
    this.commit(new Map(), this.selection, { before: { name: this.name, dataVersion: this.dataVersion }, after });
  }

  setBlocks(entries, selection = this.selection) {
    if (!Array.isArray(entries) || entries.length > MAX_BLOCKS) throw new Error('单次操作的方块数量超过上限。');
    const updates = new Map();
    for (const input of entries) {
      const pos = [...point(input?.pos)];
      const state = input.state === null ? null : stateOf(input.state);
      updates.set(cellKey(pos), state && !isAir(state.name) ? { pos, state } : null);
    }
    return this.apply(updates, selection);
  }

  fillBox(a, b, input, hollow = false) {
    const { min, max, size } = boxBetween(point(a), point(b));
    const state = stateOf(input);
    if (isAir(state.name)) return this.removeBox(min, max);
    const volume = size[0] * size[1] * size[2];
    const interior = size.reduce((n, edge) => n * Math.max(0, edge - 2), 1);
    if (volume > MAX_FILL_VOLUME || volume - (hollow ? interior : 0) > MAX_BLOCKS) throw new Error('填充区域太大。');

    const updates = new Map();
    if (hollow) {
      const box = { min, max, size };
      for (const [key, { pos }] of this.blocks) if (inBox(pos, box)) updates.set(key, null);
    }
    for (let y = min[1]; y <= max[1]; y++) {
      for (let z = min[2]; z <= max[2]; z++) {
        for (let x = min[0]; x <= max[0]; x++) {
          if (hollow && x > min[0] && x < max[0] && y > min[1] && y < max[1] && z > min[2] && z < max[2]) continue;
          const pos = [x, y, z];
          updates.set(cellKey(pos), { pos, state });
        }
      }
    }
    return this.apply(updates, this.selection);
  }

  removeBox(a, b) {
    const box = boxBetween(point(a), point(b));
    const updates = new Map();
    for (const [key, { pos }] of this.blocks) if (inBox(pos, box)) updates.set(key, null);
    return this.apply(updates, this.selection);
  }

  removeSelection() {
    return this.apply(new Map([...this.selection].map(key => [key, null])), new Set());
  }

  paintSelection(input) {
    const state = stateOf(input);
    return this.setBlocks(this.selected.map(({ pos }) => ({ pos, state })));
  }

  transform({ origin, rotation = 0, size } = {}) {
    const selected = this.selected;
    const bounds = boundsOf(selected);
    if (!bounds) throw new Error('请先选择方块。');
    if (![0, 90, 180, 270, -90, -180, -270].includes(rotation)) throw new Error('旋转角度必须是 90° 的倍数（最多 270°）。');
    const turns = (rotation / 90 + 4) % 4;
    const [width, height, depth] = bounds.size;
    const rotatedSize = turns % 2 ? [depth, height, width] : bounds.size;
    const targetSize = size === undefined ? rotatedSize : point(size, '尺寸');
    if (targetSize.some(n => n < 1)) throw new Error('尺寸必须大于 0。');
    const target = origin === undefined ? bounds.min : point(origin, '选区原点');
    point(target.map((n, i) => n + targetSize[i] - 1), '选区末端');
    const scaleBoundary = (n, axis) => Math.ceil(n * targetSize[axis] / rotatedSize[axis] - 0.5);
    const updates = new Map([...this.selection].map(key => [key, null]));
    const keys = new Set();
    for (const { pos, state } of selected) {
      const [x, y, z] = pos.map((n, i) => n - bounds.min[i]);
      const rotated = [[x, y, z], [depth - 1 - z, y, x], [width - 1 - x, y, depth - 1 - z], [z, y, width - 1 - x]][turns];
      const min = rotated.map(scaleBoundary);
      const max = rotated.map((n, i) => scaleBoundary(n + 1, i));
      const count = max.reduce((n, end, i) => n * (end - min[i]), 1);
      if (keys.size + count > MAX_BLOCKS) throw new Error('变换后的方块数量超过上限。');
      if (!count) continue;
      const nextState = rotateState(state, turns);
      for (let sy = min[1]; sy < max[1]; sy++) {
        for (let sz = min[2]; sz < max[2]; sz++) {
          for (let sx = min[0]; sx < max[0]; sx++) {
            const nextPos = [target[0] + sx, target[1] + sy, target[2] + sz];
            const key = cellKey(nextPos);
            if (this.blocks.has(key) && !this.selection.has(key)) throw new Error(`变换与 (${key}) 处的方块重叠。`);
            updates.set(key, { pos: nextPos, state: nextState });
            keys.add(key);
          }
        }
      }
    }
    if (!keys.size) throw new Error('缩小后选区为空，请增大目标尺寸。');
    return this.apply(updates, keys);
  }

  apply(updates, selection) {
    const changes = new Map();
    let count = this.blocks.size;
    for (const [key, after] of updates) {
      const before = this.blocks.get(key) ?? null;
      if ((!before && !after) || (before && after && stateKey(before.state) === stateKey(after.state))) continue;
      count += Number(Boolean(after)) - Number(Boolean(before));
      changes.set(key, { before, after });
    }
    if (count > MAX_BLOCKS) throw new Error(`场景最多包含 ${MAX_BLOCKS.toLocaleString()} 个方块。`);
    if (changes.size) this.commit(changes, selection);
    return changes.size;
  }

  commit(changes, selection, metadata) {
    const entry = {
      changes, metadata,
      beforeSelection: this.selection, afterSelection: new Set(selection),
      beforeRevision: this.revision, afterRevision: ++this.lastRevision,
    };
    this.history.push(entry);
    this.future = [];
    let kept = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      kept += this.history[i].changes.size;
      if (i < this.history.length - 60 || kept > MAX_HISTORY_CHANGES) {
        this.history.splice(0, i + 1);
        break;
      }
    }
    this.restore(entry, 'after');
  }

  restore(entry, side) {
    for (const [key, change] of entry.changes) {
      const block = change[side];
      if (block) this.blocks.set(key, block);
      else this.blocks.delete(key);
    }
    if (entry.metadata) Object.assign(this, entry.metadata[side]);
    this.revision = entry[`${side}Revision`];
    this.selection = new Set([...entry[`${side}Selection`]].filter(key => this.blocks.has(key)));
    this.notify({ changes: entry.changes });
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this.future.push(entry);
    this.restore(entry, 'before');
    return true;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return false;
    this.history.push(entry);
    this.restore(entry, 'after');
    return true;
  }
}
