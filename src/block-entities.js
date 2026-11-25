import legacyPatterns from './banner-patterns.json' with { type: 'json' };

export const DYE_COLORS = {
  white: 0xf9fffe, orange: 0xf9801d, magenta: 0xc74ebd, light_blue: 0x3ab3da,
  yellow: 0xfed83d, lime: 0x80c71f, pink: 0xf38baa, gray: 0x474f52,
  light_gray: 0x9d9d97, cyan: 0x169c9c, purple: 0x8932b8, blue: 0x3c44aa,
  brown: 0x835432, green: 0x5e7c16, red: 0xb02e26, black: 0x1d1d21,
};
export const MAX_BANNER_LAYERS = 16;
export const JIGSAW_ORIENTATIONS = [
  'north_up', 'east_up', 'south_up', 'west_up',
  'up_north', 'up_east', 'up_south', 'up_west', 'down_north', 'down_east', 'down_south', 'down_west',
];
const dyes = Object.keys(DYE_COLORS);
const legacyIds = new Map(Object.entries(legacyPatterns).map(([id, name]) => ['minecraft:' + name, id]));
const resourceId = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/;
const qualified = id => id.includes(':') ? id : 'minecraft:' + id;

export function bannerColor(name) {
  const match = /^minecraft:([a-z_]+?)(?:_wall)?_banner$/.exec(name);
  return match && Object.hasOwn(DYE_COLORS, match[1]) ? match[1] : null;
}

export function blockEntityKind(name) {
  if (name === 'minecraft:jigsaw') return 'jigsaw';
  if (bannerColor(name)) return 'banner';
  return null;
}

export function defaultJigsaw(state) {
  const vertical = /^(up|down)_/.test(state.properties?.orientation ?? '');
  return {
    name: 'minecraft:empty', target: 'minecraft:empty', pool: 'minecraft:empty', final_state: 'minecraft:air',
    joint: vertical ? 'rollable' : 'aligned', selection_priority: 0, placement_priority: 0,
  };
}

function id(value) {
  if (typeof value !== 'string') throw new Error('需要 Minecraft 资源 ID。');
  const name = qualified(value.trim());
  if (name.length > 256 || !resourceId.test(name)) throw new Error('无效的 Minecraft 资源 ID。');
  return name;
}

function i32(value) {
  if (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647) {
    throw new Error('拼图方块的优先级需要是 32 位整数。');
  }
  return value;
}

export function blockEntityOf(state, value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('方块实体数据需要是对象。');
  switch (blockEntityKind(state.name)) {
    case 'banner': {
      if (!Array.isArray(value.patterns) || value.patterns.length > MAX_BANNER_LAYERS) throw new Error('旗帜最多支持 16 层图案。');
      const patterns = value.patterns.map(layer => {
        if (typeof layer?.color !== 'string' || !Object.hasOwn(DYE_COLORS, layer.color)) throw new Error('旗帜图案的染料颜色无效。');
        return { pattern: id(layer.pattern), color: layer.color };
      });
      return patterns.length ? { patterns } : undefined;
    }
    case 'jigsaw': {
      const defaults = defaultJigsaw(state);
      if (Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new Error('拼图方块参数含有未知字段。');
      const data = { ...defaults, ...value };
      const { joint, final_state } = data;
      if (joint !== 'aligned' && joint !== 'rollable') throw new Error('拼图方块的连接方式无效。');
      if (typeof final_state !== 'string' || !final_state.trim() || final_state.length > 2048 || /[\0\r\n]/.test(final_state)) {
        throw new Error('拼图方块的替换方块状态无效。');
      }
      return {
        name: id(data.name), target: id(data.target), pool: id(data.pool), final_state: final_state.trim(),
        joint, selection_priority: i32(data.selection_priority), placement_priority: i32(data.placement_priority),
      };
    }
    default: throw new Error('当前方块不支持编辑这类方块实体数据。');
  }
}

export function readBlockEntity(state, tag) {
  if (!tag || typeof tag !== 'object') return undefined;
  try {
    const kind = blockEntityKind(state.name);
    if (kind === 'banner') {
      const patterns = Array.isArray(tag.patterns) ? tag.patterns : Array.isArray(tag.Patterns) ? tag.Patterns : [];
      const layers = [];
      for (const layer of patterns) {
        if (!layer || typeof layer !== 'object') continue;
        const pattern = layer.pattern ?? legacyPatterns[layer.Pattern];
        const color = layer.color ?? dyes[layer.Color];
        try { layers.push({ pattern: id(pattern), color: Object.hasOwn(DYE_COLORS, color) ? color : 'white' }); }
        catch { continue; }
        if (layers.length === MAX_BANNER_LAYERS) break;
      }
      return blockEntityOf(state, { patterns: layers });
    }
    if (kind === 'jigsaw') {
      const settings = defaultJigsaw(state);
      for (const key of Object.keys(settings)) {
        if (typeof tag[key] === typeof settings[key] && tag[key] !== '') settings[key] = tag[key];
      }
      return blockEntityOf(state, settings);
    }
  } catch { /* Ignore unsupported or malformed block entity data. */ }
  return undefined;
}

export function writeBlockEntity(state, value, dataVersion) {
  const kind = blockEntityKind(state.name);
  if (kind === 'jigsaw') return { id: 'minecraft:jigsaw', ...(blockEntityOf(state, value) ?? defaultJigsaw(state)) };
  if (kind !== 'banner') return null;
  const data = blockEntityOf(state, value);
  if (!data) return null;
  if (dataVersion >= 3837) return { id: 'minecraft:banner', patterns: data.patterns };
  const Patterns = data.patterns.map(({ pattern, color }) => {
    const shortId = legacyIds.get(pattern);
    if (!shortId) throw new Error('目标 Java 版本没有旗帜图案 ' + pattern + '。');
    return { Pattern: shortId, Color: dyes.indexOf(color) };
  });
  return { id: 'minecraft:banner', Patterns };
}
