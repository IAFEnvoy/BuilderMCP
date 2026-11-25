import { bannerColor, DYE_COLORS, JIGSAW_ORIENTATIONS } from './block-entities.js';

const sides = ['north', 'east', 'south', 'west'];
const facingAngles = new Map([['south', 0], ['west', 90], ['north', 180], ['east', 270]]);
const dyeNames = Object.keys(DYE_COLORS);
const rotations = Array.from({ length: 16 }, (_, i) => String(i));
const chestTextures = { chest: 'normal', trapped_chest: 'trapped', ender_chest: 'ender' };
const markers = new Set(['barrier', 'light', 'structure_void']);

function vanillaPath(name) {
  return name.startsWith('minecraft:') ? name.slice(10) : '';
}

function shulkerColor(path) {
  if (path === 'shulker_box') return '';
  const color = path.endsWith('_shulker_box') ? path.slice(0, -12) : null;
  return dyeNames.includes(color) ? color : null;
}

export function specialBlockProperties(name) {
  const path = vanillaPath(name);
  if (Object.hasOwn(chestTextures, path)) {
    const properties = { facing: sides, waterlogged: ['false', 'true'] };
    if (path !== 'ender_chest') properties.type = ['single', 'left', 'right'];
    return properties;
  }
  if (bannerColor(name)) return path.endsWith('_wall_banner') ? { facing: sides } : { rotation: rotations };
  if (shulkerColor(path) !== null) return { facing: ['up', 'down', ...sides] };
  if (path === 'light') return { level: [...rotations].reverse(), waterlogged: ['false', 'true'] };
  if (path === 'barrier') return { waterlogged: ['false', 'true'] };
  if (path === 'jigsaw') return { orientation: JIGSAW_ORIENTATIONS };
  return {};
}

const packTexture = path => 'minecraft:' + path;

function textureFrom(catalog, paths) {
  return paths.map(packTexture).find(key => catalog.textures.has(key));
}

function atlasCuboid(from, to, texture, [w, h, d, u, v], omit = []) {
  // Entity textures use a 64 by 64 box unwrap, scaled along with the resource pack.
  const x0 = u + d;
  const x1 = x0 + w;
  const x2 = x1 + d;
  const y0 = v + d;
  const y1 = y0 + h;
  const layout = {
    west: [u, y0, x0, y1],
    north: [x0, y0, x1, y1],
    east: [x1, y0, x2, y1],
    south: [x2, y0, x2 + w, y1],
    down: [x0, v, x1, y0],
    up: [x1, v, x1 + w, y0],
  };
  const faces = Object.fromEntries(Object.entries(layout)
    .filter(([face]) => !omit.includes(face))
    .map(([face, uv]) => [face, { texture, uv: uv.map(pixel => pixel / 4) }]));
  return { from, to, faces };
}

function preview(key, elements, angles = {}) {
  return { key, model: { namespace: 'minecraft', textures: {}, elements }, ...angles };
}

function chestPart(catalog, path, properties) {
  const base = chestTextures[path];
  const wanted = path !== 'ender_chest' && ['left', 'right'].includes(properties.type) ? properties.type : 'single';
  const texture = textureFrom(catalog, wanted === 'single'
    ? ['entity/chest/' + base]
    : ['entity/chest/' + base + '_' + wanted, 'entity/chest/' + base]);
  if (!texture) return null;
  const half = texture.endsWith('_' + wanted) ? wanted : 'single';
  const left = half === 'left';
  const right = half === 'right';
  const x0 = left ? 0 : 1;
  const x1 = right ? 16 : 15;
  const width = x1 - x0;
  const seam = left ? ['west'] : right ? ['east'] : [];
  const y = facingAngles.get(properties.facing) ?? 180;
  const elements = [
    atlasCuboid([x0, 0, 1], [x1, 9, 15], texture, [width, 9, 14, 0, 19], seam),
    atlasCuboid([x0, 9, 1], [x1, 14, 15], texture, [width, 5, 14, 0, 0], seam),
    atlasCuboid([left ? 0 : right ? 15 : 7, 7, 15], [left ? 1 : right ? 16 : 9, 11, 16],
      texture, [half === 'single' ? 2 : 1, 4, 1, 0, 0], seam),
  ];
  for (const { faces } of elements) {
    for (const direction of sides) {
      const face = faces[direction];
      if (!face) continue;
      const [u0, v0, u1, v1] = face.uv;
      face.uv = [u1, v1, u0, v0];
    }
    const { uv } = faces.up;
    [uv[1], uv[3]] = [uv[3], uv[1]];
  }
  return preview(texture + ':' + y, elements, { y });
}

function shulkerPart(catalog, path, properties) {
  const color = shulkerColor(path);
  const texture = textureFrom(catalog, [color ? 'entity/shulker/shulker_' + color : 'entity/shulker/shulker']);
  if (!texture) return null;
  const facing = properties.facing ?? 'up';
  const x = facing === 'up' ? 0 : facing === 'down' ? 180 : -90;
  const y = facingAngles.get(facing) ?? 0;
  // The lower shell fills holes in the lid texture. Inset the overlapping sides to avoid z-fighting.
  const lower = atlasCuboid([0.015, 0, 0.015], [15.985, 8, 15.985], texture, [16, 8, 16, 0, 28], ['up']);
  const upper = atlasCuboid([0, 4, 0], [16, 16, 16], texture, [16, 12, 16, 0, 0], ['down']);
  // The shell is unwrapped with its top toward the bottom of the entity model.
  for (const box of [lower, upper]) {
    const faces = box.faces;
    const caps = lower === box ? [32, 44, 48, 28] : [16, 0, 32, 16];
    faces[lower === box ? 'down' : 'up'].uv = caps.map(pixel => pixel / 4);
    [faces.north, faces.south] = [faces.south, faces.north];
  }
  return preview(texture + ':' + facing, [lower, upper], { x, y });
}

function clothImage(catalog, baseTexture, baseColor, patterns) {
  const textures = [[baseTexture, baseColor], ...patterns.map(({ pattern, color }) => [catalog.bannerPatternTexture(pattern), color])];
  return Promise.all(textures.map(async ([name, color]) => ({ record: name ? await catalog.image(name) : null, color })))
    .then(layers => {
      const base = layers[0].record?.image;
      if (!base) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(base.width * 20 / 64));
      canvas.height = Math.max(1, Math.round(base.height * 40 / 64));
      const output = canvas.getContext('2d');
      const layer = document.createElement('canvas');
      layer.width = canvas.width;
      layer.height = canvas.height;
      const context = layer.getContext('2d');
      const drawMask = image => context.drawImage(image, image.width / 64, image.height / 64,
        image.width * 20 / 64, image.height * 40 / 64, 0, 0, layer.width, layer.height);
      context.imageSmoothingEnabled = false;
      for (const { record, color } of layers) {
        if (!record) continue;
        context.globalCompositeOperation = 'copy';
        context.fillStyle = '#' + DYE_COLORS[color].toString(16).padStart(6, '0');
        context.fillRect(0, 0, layer.width, layer.height);
        context.globalCompositeOperation = 'multiply';
        drawMask(record.image);
        context.globalCompositeOperation = 'destination-in';
        drawMask(record.image);
        output.drawImage(layer, 0, 0);
      }
      return { image: canvas, translucent: false };
    });
}

function bannerPart(catalog, state, entity) {
  const base = textureFrom(catalog, ['entity/banner/banner_base', 'entity/banner_base']);
  if (!base) return null;
  const color = bannerColor(state.name);
  const patterns = entity?.patterns ?? [];
  const texture = 'buildermcp:preview/banner/' + JSON.stringify([color, patterns]);
  if (!catalog.textures.has(texture)) catalog.textures.set(texture, { load: () => clothImage(catalog, base, color, patterns) });

  const wall = state.name.endsWith('_wall_banner');
  const properties = state.properties ?? {};
  const y = wall ? facingAngles.get(properties.facing) ?? 180 : (Number(properties.rotation) || 0) * 22.5;
  const top = wall ? 14 : 29;
  const bottom = top - 26;
  const z = wall ? 2 : 9;
  const cloth = {
    from: [1.5, bottom, z], to: [14.5, top, z],
    faces: { south: { texture, uv: [0, 0, 16, 16] }, north: { texture, uv: [16, 0, 0, 16] } },
  };
  const rail = atlasCuboid([1, top - 0.4, z - 0.8], [15, top + 0.9, z + 0.6], base, [20, 2, 2, 0, 42]);
  const elements = [cloth, rail];
  if (!wall) elements.push(atlasCuboid([7.4, 0, 7.4], [8.6, top, 8.6], base, [2, 42, 2, 44, 0]));
  return preview(texture + ':' + wall + ':' + y, elements, { y, fitThumbnail: true });
}

function markerPart(catalog, path, properties, particle) {
  const level = String(properties.level ?? 15).padStart(2, '0');
  const texture = particle && catalog.textures.has(particle) ? particle : textureFrom(catalog,
    path === 'light' ? ['item/light_' + level, 'item/light'] : ['item/' + path]);
  if (!texture) return null;
  const sprite = { texture, uv: [0, 0, 16, 16] };
  return preview('marker:' + texture, [{
    from: [3, 3, 8], to: [13, 13, 8], shade: false, faces: { south: sprite },
  }], { marker: true });
}

export function specialBlockPart(catalog, state, entity, particle) {
  const path = vanillaPath(state.name);
  const properties = state.properties ?? {};
  if (Object.hasOwn(chestTextures, path)) return chestPart(catalog, path, properties);
  if (shulkerColor(path) !== null) return shulkerPart(catalog, path, properties);
  if (bannerColor(state.name)) return bannerPart(catalog, state, entity);
  if (markers.has(path)) return markerPart(catalog, path, properties, particle);
  return null;
}
