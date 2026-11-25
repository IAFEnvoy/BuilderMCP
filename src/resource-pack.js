import { strFromU8, unzip } from 'fflate';
import { DEFAULT_LOCALE, ENGLISH_LOCALE, normalizeLocale } from './locales.js';
import { isAir, stateOf } from './scene.js';
import { decodeTexture, TEXTURE_TICK_MS } from './texture-animation.js';

const assetPath = /^(?:[^/]+\/)*?assets\/([a-z0-9_.-]+)\/(blockstates|models|items|textures|lang)\/(.+)$/;
const MAX_EXPANDED_BYTES = 384 * 1024 * 1024;
const preferred = ['north', 'y', 'bottom', 'straight', 'false', 'single', 'none', '0'];
const missingBlockPart = {
  key: 'missing-block',
  model: {
    textures: {},
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: Object.fromEntries(['down', 'up', 'north', 'south', 'west', 'east'].map(face => [face, { texture: '#missing' }])),
    }],
  },
};
let checkerboard;

function missingTextureImage() {
  if (!checkerboard) {
    const image = document.createElement('canvas');
    image.width = image.height = 16;
    const ctx = image.getContext('2d');
    ctx.fillStyle = '#130c1c';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillStyle = '#df29d7';
    ctx.fillRect(0, 0, 8, 8);
    ctx.fillRect(8, 8, 8, 8);
    checkerboard = { image, translucent: false, missing: true };
  }
  return checkerboard;
}

function parseJson(bytes) {
  try {
    const value = JSON.parse(strFromU8(bytes).replace(/^\uFEFF/, ''));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function supported(file) {
  if (file === 'version.json') return true;
  const [, , kind, path] = assetPath.exec(file) ?? [];
  if (kind === 'blockstates' || kind === 'models' || kind === 'items') return path.endsWith('.json');
  if (kind === 'textures') return /\.png(?:\.mcmeta)?$/.test(path);
  return kind === 'lang' && Boolean(languageFile(path));
}

function languageFile(path) {
  const match = /^([a-z0-9_-]+)\.(json|lang)$/i.exec(path);
  const locale = normalizeLocale(match?.[1]);
  return locale ? { locale, legacy: match[2].toLowerCase() === 'lang' } : null;
}

function translations(data, legacy) {
  if (!legacy) return Object.entries(parseJson(data) ?? {});
  const text = strFromU8(data).replace(/^\uFEFF/, '');
  return text.split(/\r?\n/).flatMap(line => {
    const split = line.indexOf('=');
    return split > 0 && !line.startsWith('#') ? [[line.slice(0, split), line.slice(split + 1)]] : [];
  });
}

export async function loadArchive(bytes, progress) {
  const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));
  if (progress) {
    progress({ stage: 'unpack' });
    await yieldToUi();
  }
  let expanded = 0;
  const files = await new Promise((resolve, reject) => {
    unzip(bytes, {
      filter(file) {
        if (!supported(file.name)) return false;
        expanded += file.originalSize;
        if (expanded > MAX_EXPANDED_BYTES) throw new Error('资源包的可加载内容超过 384 MiB。');
        return true;
      },
    }, (error, data) => error ? reject(error) : resolve(data));
  });
  const pack = { states: new Map(), models: new Map(), items: new Map(), textures: new Map(), animation: new Map(), languages: new Map(), minecraftVersion: null };
  const languageEntries = [];
  const entries = Object.entries(files);
  const total = entries.length;
  let processed = 0;
  let lastUpdate = performance.now();
  async function reportIndex() {
    progress({ stage: 'index', processed, total });
    await yieldToUi();
    lastUpdate = performance.now();
  }
  if (progress) await reportIndex();
  for (const [filename, data] of entries) {
    if (progress && performance.now() - lastUpdate >= 50) await reportIndex();
    if (filename === 'version.json') {
      const version = parseJson(data);
      if (Number.isInteger(version?.world_version) && typeof version.id === 'string' && /^[a-z0-9][a-z0-9._+-]{0,79}$/i.test(version.id)) {
        pack.minecraftVersion = version.id;
      }
      processed++;
      continue;
    }
    const [, namespace, kind, path] = assetPath.exec(filename);
    const id = suffix => `${namespace}:${path.slice(0, -suffix.length)}`;
    if (kind === 'lang') {
      languageEntries.push({ ...languageFile(path), data });
      continue;
    }
    processed++;
    if (kind === 'textures') {
      if (path.endsWith('.png')) pack.textures.set(id('.png'), data);
      else pack.animation.set(id('.png.mcmeta'), parseJson(data)?.animation);
      continue;
    }
    const value = parseJson(data);
    if (!value) continue;
    if (kind === 'blockstates') pack.states.set(id('.json'), value);
    if (kind === 'models') pack.models.set(id('.json'), value);
    if (kind === 'items') pack.items.set(id('.json'), value);
  }
  languageEntries.sort((a, b) => Number(b.legacy) - Number(a.legacy));
  for (const { locale, legacy, data } of languageEntries) {
    if (progress && performance.now() - lastUpdate >= 50) await reportIndex();
    const entries = pack.languages.get(locale) ?? new Map();
    for (const [key, value] of translations(data, legacy)) {
      if ((key.startsWith('block.') || key.startsWith('item.')) && typeof value === 'string' && value.trim()) entries.set(key, value);
    }
    if (entries.size) pack.languages.set(locale, entries);
    processed++;
  }
  if (!pack.states.has('minecraft:stone') || !pack.languages.get(ENGLISH_LOCALE)?.has('block.minecraft.stone')) pack.minecraftVersion = null;
  if (!pack.states.size && !pack.models.size && !pack.items.size && !pack.textures.size && !pack.animation.size && !pack.languages.size) {
    throw new Error('资源包中没有找到可用的方块数据、纹理或译名。');
  }
  progress?.({ stage: 'index', processed, total });
  return pack;
}

const qualify = (id, namespace) => id.includes(':') ? id : `${namespace}:${id}`;
const namespaceOf = id => id.split(':', 1)[0];
const variantsOf = definition => Object.entries(definition?.variants ?? {});
const partsOf = definition => Array.isArray(definition?.multipart) ? definition.multipart : [];

function inventoryEntries(node, properties, inherited = [], depth = 0) {
  if (typeof node?.type !== 'string' || depth >= 32) return [];
  const transforms = node.transformation ? [...inherited, node.transformation] : inherited;
  const resolve = child => inventoryEntries(child, properties, transforms, depth + 1);
  switch (qualify(node.type, 'minecraft')) {
    case 'minecraft:model':
      return typeof node.model === 'string' ? [{ reference: node.model, tints: node.tints, transforms }] : [];
    case 'minecraft:composite':
      return Array.isArray(node.models) ? node.models.flatMap(resolve) : [];
    case 'minecraft:select': {
      const selection = node.property === 'minecraft:display_context' ? 'gui'
        : node.property === 'minecraft:block_state' ? properties?.[node.block_state_property] : undefined;
      const match = selection === undefined || !Array.isArray(node.cases) ? null : node.cases.find(entry =>
        [entry?.when].flat().some(value => value === selection || value === `minecraft:${selection}`));
      return resolve(match?.model ?? node.fallback);
    }
    case 'minecraft:condition': return resolve(node.on_false);
    case 'minecraft:range_dispatch': return resolve(node.fallback);
    default: return [];
  }
}

function generatedLayers(textures) {
  const elements = [];
  for (let layer = 0; layer < 5; layer++) {
    const slot = `layer${layer}`;
    if (!Object.hasOwn(textures, slot)) break;
    const face = { texture: `#${slot}`, tintindex: layer, uv: [0, 0, 16, 16] };
    elements.push({
      from: [0, 0, 7.5 - layer * 0.01], to: [16, 16, 8.5 + layer * 0.01], shade: false,
      faces: { south: face, north: { ...face, uv: [16, 0, 0, 16] } },
    });
  }
  return elements;
}

function variantCondition(key) {
  return Object.fromEntries(key.split(',').map(part => part.split('=')).filter(([k, v]) => k && v));
}

function accepts(condition, properties) {
  if (!condition || typeof condition !== 'object') return !condition;
  return Object.entries(condition).every(([key, value]) => {
    if (key === 'OR') return Array.isArray(value) && value.some(part => accepts(part, properties));
    if (key === 'AND') return Array.isArray(value) && value.every(part => accepts(part, properties));
    if (typeof value !== 'string' || properties[key] === undefined) return false;
    if (value.startsWith('!')) return !value.slice(1).split('|').includes(properties[key]);
    return value.split('|').includes(properties[key]);
  });
}

function propertyOptions(definition) {
  const options = new Map();
  function add(condition) {
    if (!condition || typeof condition !== 'object') return;
    for (const [key, value] of Object.entries(condition)) {
      if ((key === 'AND' || key === 'OR') && Array.isArray(value)) value.forEach(add);
      if (typeof value !== 'string') continue;
      if (!options.has(key)) options.set(key, new Set());
      const result = options.get(key);
      for (const candidate of value.replace(/^!/, '').split('|')) if (candidate) result.add(candidate);
      if (result.has('true') || result.has('false')) ['true', 'false'].forEach(v => result.add(v));
    }
  }
  for (const [key] of variantsOf(definition)) add(variantCondition(key));
  for (const part of partsOf(definition)) add(part?.when);
  const defaultsFirst = (a, b) => (preferred.includes(a) ? preferred.indexOf(a) : preferred.length) -
    (preferred.includes(b) ? preferred.indexOf(b) : preferred.length) || a.localeCompare(b, undefined, { numeric: true });
  return Object.fromEntries([...options].map(([key, values]) => [key, [...values].sort(defaultsFirst)]).filter(([, values]) => values.length));
}

function categoryOf(name) {
  const path = name.split(':')[1];
  if (/planks|(?:^|_)log$|(?:^|_)wood$|bamboo|(?:spruce|oak|birch|jungle|acacia|mangrove|crimson|warped|cherry|pale_oak)_(?!leaves|sapling)/.test(path)) return 'wood';
  if (/leaves|sapling|flower|grass|moss|dirt|vine|fern|coral|roots|mushroom/.test(path)) return 'nature';
  if (/stone|sandstone|brick|tuff|slate|cobble|andesite|diorite|granite|calcite|basalt|obsidian|blackstone/.test(path)) return 'stone';
  return 'decor';
}

function chooseWeighted(value, pos, salt) {
  if (!Array.isArray(value)) return value;
  const candidates = value.filter(entry => typeof entry?.model === 'string');
  const weight = entry => Number.isSafeInteger(entry.weight) && entry.weight > 0 ? Math.min(entry.weight, 100_000) : 1;
  const total = candidates.reduce((sum, entry) => sum + weight(entry), 0);
  const [x, y, z] = pos;
  let seed = Math.imul(x, 73428767) ^ Math.imul(y, 912931) ^ Math.imul(z, 438289) ^ salt;
  seed = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
  let bucket = ((seed ^ (seed >>> 16)) >>> 0) % total;
  return candidates.find(entry => (bucket -= weight(entry)) < 0);
}

export class BlockCatalog {
  #blocksByNamespace = new Map();
  #animationStart = performance.now();

  constructor(packs = [], locale = DEFAULT_LOCALE, officialLanguages = new Map()) {
    this.states = new Map();
    this.models = new Map();
    this.items = new Map();
    this.textures = new Map();
    this.languages = new Map();
    this.locale = locale;
    this.officialLanguages = officialLanguages;
    this.blocks = new Map();
    this.compiled = new Map();
    this.images = new Map();
    for (const pack of packs) {
      for (const [key, value] of pack.states) this.states.set(key, value);
      for (const [key, value] of pack.models) this.models.set(key, value);
      for (const [key, value] of pack.items ?? []) this.items.set(key, value);
      for (const [key, bytes] of pack.textures) this.textures.set(key, { bytes });
      for (const [key, animation] of pack.animation) {
        const texture = this.textures.get(key);
        if (texture) texture.animation = animation;
      }
      for (const [code, labels] of pack.languages) {
        if (!this.languages.has(code)) this.languages.set(code, new Map());
        const layer = this.languages.get(code);
        for (const [key, value] of labels) layer.set(key, value);
      }
    }
    for (const [name, definition] of this.states) {
      try {
        const properties = propertyOptions(definition);
        const defaults = Object.fromEntries(Object.entries(properties).map(([key, values]) => [key, values[0]]));
        const block = { name, label: this.label(name), category: categoryOf(name), properties, state: stateOf({ name, properties: defaults }) };
        this.blocks.set(name, block);
        const namespace = namespaceOf(name);
        if (!this.#blocksByNamespace.has(namespace)) this.#blocksByNamespace.set(namespace, []);
        this.#blocksByNamespace.get(namespace).push(block);
      } catch { /* Skip out-of-format resource IDs and state properties. */ }
    }
  }

  get namespaces() {
    return [...this.#blocksByNamespace.keys()].sort();
  }

  setLocale(locale) {
    this.locale = locale;
    for (const block of this.blocks.values()) block.label = this.label(block.name);
  }

  label(name, locale = this.locale) {
    const suffix = name.replace(':', '.').replaceAll('/', '.');
    const blockKey = `block.${suffix}`;
    const itemKey = `item.${suffix}`;
    const lookup = code => {
      const local = this.languages.get(code);
      const official = this.officialLanguages.get(code);
      return local?.get(blockKey) ?? official?.get(blockKey) ?? local?.get(itemKey) ?? official?.get(itemKey);
    };
    return lookup(locale) ?? (locale === ENGLISH_LOCALE ? undefined : lookup(ENGLISH_LOCALE)) ?? blockKey;
  }

  find(query = '', category = 'all', namespace = '') {
    const text = query.trim().toLocaleLowerCase();
    const candidates = namespace ? this.#blocksByNamespace.get(namespace) ?? [] : this.blocks.values();
    return [...candidates].filter(block => (category === 'all' || category === block.category) &&
      (block.name.includes(text) || block.label.toLowerCase().includes(text) || this.label(block.name, ENGLISH_LOCALE).toLowerCase().includes(text)));
  }

  state(input) {
    const state = stateOf(input);
    const base = this.blocks.get(state.name)?.state;
    return stateOf({ name: state.name, properties: { ...base?.properties, ...state.properties } });
  }

  model(name, visiting = new Set()) {
    if (this.compiled.has(name)) return this.compiled.get(name);
    if (visiting.has(name) || visiting.size >= 64) return null;
    const definition = this.models.get(name);
    if (name === 'minecraft:builtin/generated' || (name === 'minecraft:item/generated' && !definition)) {
      const model = { name, textures: {}, elements: [], generated: true, guiLight: 'front' };
      this.compiled.set(name, model);
      return model;
    }
    if (!definition) {
      this.compiled.set(name, null);
      return null;
    }
    const namespace = namespaceOf(name);
    visiting.add(name);
    const parent = typeof definition.parent === 'string' ? this.modelRef(definition.parent, namespace, visiting) : null;
    visiting.delete(name);
    const textures = Object.assign(Object.create(null), parent?.textures);
    for (const [key, value] of Object.entries(definition.textures ?? {})) {
      if (typeof value === 'string') textures[key] = value.startsWith('#') ? value : { texture: this.textureRef(value, namespace), forceTranslucent: false };
      else if (typeof value?.sprite === 'string') textures[key] = { texture: this.textureRef(value.sprite, namespace), forceTranslucent: value.force_translucent === true };
    }
    const ownElements = Array.isArray(definition.elements);
    const model = {
      name, textures, elements: ownElements ? definition.elements : parent?.elements ?? [],
      generated: !ownElements && Boolean(parent?.generated),
      namespace: ownElements ? namespace : parent?.namespace ?? namespace,
      gui: definition.display?.gui ?? parent?.gui,
      guiLight: definition.gui_light ?? parent?.guiLight,
    };
    this.compiled.set(name, model);
    return model;
  }

  modelRef(reference, namespace, visiting) {
    const standard = qualify(reference, 'minecraft');
    const local = qualify(reference, namespace);
    return this.model(standard, visiting) ?? (local === standard ? null : this.model(local, visiting));
  }

  textureRef(reference, namespace) {
    const standard = qualify(reference, 'minecraft');
    if (reference.includes(':') || this.textures.has(standard)) return standard;
    const local = qualify(reference, namespace);
    return this.textures.has(local) ? local : standard;
  }

  textureMaterial(model, value) {
    if (typeof value !== 'string') return null;
    const seen = new Set();
    while (typeof value === 'string') {
      const slot = value.startsWith('#') ? value.slice(1) : value;
      if (!value.startsWith('#') && !Object.hasOwn(model.textures, slot)) {
        return { texture: this.textureRef(value, model.namespace), forceTranslucent: false };
      }
      if (seen.has(slot)) return null;
      seen.add(slot);
      value = model.textures[slot];
    }
    return typeof value?.texture === 'string' ? value : null;
  }

  itemParts({ name, properties }) {
    if (isAir(name)) return [];
    const [namespace, path] = name.split(':');
    const definition = this.items.get(name);
    const entries = definition ? inventoryEntries(definition.model, properties) : [{ reference: `${namespace}:item/${path}`, transforms: [] }];
    return entries.flatMap(({ reference, tints, transforms }) => {
      const model = this.modelRef(reference, namespace);
      if (!model) return [];
      const elements = model.generated ? generatedLayers(model.textures) : model.elements;
      return elements.length ? [{ model: { ...model, elements }, tints, transforms }] : [];
    });
  }

  parts(state, pos) {
    const { name, properties = {} } = state;
    if (isAir(name)) return [];
    const definition = this.states.get(name);
    if (definition) {
      const completed = { ...this.blocks.get(name)?.state.properties, ...properties };
      const variants = variantsOf(definition);
      const match = variants.find(([key]) => key && accepts(variantCondition(key), completed)) ?? variants.find(([key]) => !key) ?? variants[0];
      const choices = match ? [match[1]] : [];
      for (const part of partsOf(definition)) if (part?.apply && accepts(part.when, completed)) choices.push(part.apply);
      const namespace = namespaceOf(name);
      const parts = choices.flatMap((choice, i) => {
        const selected = chooseWeighted(choice, pos, i);
        if (typeof selected?.model !== 'string') return [];
        const model = this.modelRef(selected.model, namespace);
        const x = Number.isFinite(selected.x) ? selected.x : 0;
        const y = Number.isFinite(selected.y) ? selected.y : 0;
        const z = Number.isFinite(selected.z) ? selected.z : 0;
        const uvlock = selected.uvlock === true;
        return model?.elements.length ? [{ key: `${model.name}:${x}:${y}:${z}:${uvlock}`, model, x, y, z, uvlock }] : [];
      });
      if (parts.length) return parts;
    }

    const [namespace, path] = name.split(':');
    const key = `${namespace}:block/${path}`;
    const model = this.model(key);
    return model?.elements.length ? [{ key, model }] : [missingBlockPart];
  }

  image(key) {
    const resource = this.textures.get(key);
    if (!resource) return Promise.resolve(null);
    if (!this.images.has(key)) {
      this.images.set(key, decodeTexture(resource.bytes, resource.animation).catch(() => null));
    }
    return this.images.get(key);
  }

  animationTick(now = performance.now()) {
    return Math.max(0, Math.floor((now - this.#animationStart) / TEXTURE_TICK_MS));
  }

  async textureImage(key) {
    return (await this.image(key)) ?? missingTextureImage();
  }
}
