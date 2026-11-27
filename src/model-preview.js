import * as THREE from 'three';
import { applyTexture, buildGeometry, materialKey, tintFor } from './model-geometry.js';
import { stateKey } from './scene.js';
import { createTexturePlayer } from './texture-animation.js';

const thumbnailSize = 64;
const blockImageSize = 256;
const radians = Math.PI / 180;
const defaultGui = { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] };
const blockCenter = new THREE.Matrix4().makeTranslation(-0.5, -0.5, -0.5);
const identity = new THREE.Matrix4();
const yieldToUi = () => new Promise(resolve => setTimeout(resolve, 0));

function vector(value, fallback) {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite) ? value : fallback;
}

function rotation(angles) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(...vector(angles, [0, 0, 0]).map(n => n * radians), 'XYZ'));
}

function quaternion(value) {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) return new THREE.Quaternion(...value).normalize();
  if (Number.isFinite(value?.angle)) {
    const axis = new THREE.Vector3(...vector(value.axis, [0, 1, 0])).normalize();
    return new THREE.Quaternion().setFromAxisAngle(axis, value.angle);
  }
  return new THREE.Quaternion();
}

function itemTransform(value) {
  if (Array.isArray(value) && value.length === 16 && value.every(Number.isFinite)) return new THREE.Matrix4().set(...value);
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...vector(value?.translation, [0, 0, 0])),
    quaternion(value?.left_rotation),
    new THREE.Vector3(...vector(value?.scale, [1, 1, 1])),
  ).multiply(new THREE.Matrix4().makeRotationFromQuaternion(quaternion(value?.right_rotation)));
}

function guiTransform(gui = {}) {
  const translation = vector(gui.translation, [0, 0, 0]).map(n => THREE.MathUtils.clamp(n / 16, -5, 5));
  const scale = vector(gui.scale, [1, 1, 1]).map(n => THREE.MathUtils.clamp(n, -4, 4));
  return new THREE.Matrix4().compose(new THREE.Vector3(...translation), rotation(gui.rotation), new THREE.Vector3(...scale))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(rotation(gui.right_rotation)))
    .multiply(blockCenter);
}

async function itemTint(catalog, source) {
  const type = source?.type?.replace?.(/^minecraft:/, '');
  const value = type === 'constant' ? source.value : source?.default;
  if (Number.isInteger(value)) return new THREE.Color(value & 0xffffff);
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) return new THREE.Color().setRGB(...value, THREE.SRGBColorSpace);
  if (type !== 'grass') return null;
  const colormap = await catalog.image('minecraft:colormap/grass');
  if (!colormap) return tintFor('minecraft:grass_block');
  const { image } = colormap;
  const temperature = THREE.MathUtils.clamp(Number.isFinite(source.temperature) ? source.temperature : 0.5, 0, 1);
  const downfall = THREE.MathUtils.clamp(Number.isFinite(source.downfall) ? source.downfall : 1, 0, 1) * temperature;
  const x = Math.floor((1 - temperature) * (image.width - 1));
  const y = Math.floor((1 - downfall) * (image.height - 1));
  const [r, g, b] = image.getContext('2d').getImageData(x, y, 1, 1).data;
  return new THREE.Color(r << 16 | g << 8 | b);
}

function extendBounds(bounds, layers) {
  const transformed = new THREE.Box3();
  for (const { matrix, batches } of layers) {
    for (const { geometry } of batches) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      bounds.union(transformed.copy(geometry.boundingBox).applyMatrix4(matrix));
    }
  }
  return bounds;
}

function frameBlock(camera, layers) {
  const bounds = extendBounds(new THREE.Box3(new THREE.Vector3(), new THREE.Vector3(1, 1, 1)), layers);
  const { center, radius } = bounds.getBoundingSphere(new THREE.Sphere());
  let distance;
  if (camera.isOrthographicCamera) {
    const halfSpan = radius / 0.9;
    camera.left = camera.bottom = -halfSpan;
    camera.right = camera.top = halfSpan;
    distance = 2 * radius;
  } else {
    const halfFov = camera.fov * radians / 2;
    distance = radius / (0.9 * Math.sin(halfFov));
  }
  camera.position.set(0, 0, distance).applyQuaternion(camera.quaternion).add(center);
  camera.near = Math.max(0.01, distance - 2 * radius);
  camera.far = distance + 2 * radius;
  camera.updateProjectionMatrix();
}

export class ModelPreview {
  cache = new Map();
  #canvasDraws = new WeakMap();
  queue = Promise.resolve();
  rendered = 0;

  constructor() {
    this.thumbnailCamera = new THREE.OrthographicCamera(-0.56, 0.56, 0.56, -0.56, 0.01, 20);
    this.thumbnailCamera.position.z = 10;
  }

  enqueue(render) {
    const pending = this.queue.then(render);
    this.queue = pending.catch(() => {});
    return pending;
  }

  async draw(catalog, state, canvas, inventory = false, entity) {
    const key = JSON.stringify([inventory, stateKey(state), entity ?? null]);
    const cache = this.cache;
    if (!cache.has(key)) {
      cache.set(key, this.prepare(catalog, state, inventory, entity).then(layers => this.enqueue(() =>
        this.render(layers, this.thumbnailCamera, thumbnailSize, { active: cache === this.cache }))));
    }
    const pending = cache.get(key);
    this.#canvasDraws.set(canvas, pending);
    const snapshot = await pending;
    if (!snapshot || cache !== this.cache || this.#canvasDraws.get(canvas) !== pending) return;
    const context = canvas.getContext('2d');
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(snapshot, 0, 0, canvas.width, canvas.height);
  }

  setCatalog() {
    this.cache = new Map();
  }

  async renderBlockStates(catalog, states, camera) {
    const rendered = new Map();
    const images = [];
    const tick = catalog.animationTick();
    const billboard = new THREE.Matrix4().makeRotationFromQuaternion(camera.quaternion)
      .setPosition(0.5, 0.5, 0.5).multiply(blockCenter);
    for (const { state, blockEntity } of states) {
      const key = JSON.stringify([stateKey(state), blockEntity ?? null]);
      if (!rendered.has(key)) {
        const tint = tintFor(state.name);
        const parts = catalog.parts(state, [0, 0, 0], blockEntity);
        const layers = await Promise.all(parts.map(part => this.prepareLayer(catalog, part, part.marker ? billboard : identity, tint)));
        frameBlock(camera, layers);
        const image = await this.enqueue(() => this.render(layers, camera, blockImageSize, { tick }));
        rendered.set(key, image.toDataURL('image/png').split(',')[1]);
      }
      images.push(rendered.get(key));
    }
    return images;
  }

  async prepare(catalog, state, inventory, entity) {
    const item = inventory ? catalog.itemParts(state) : [];
    const parts = item.length ? item : catalog.parts(state, [0, 0, 0], entity);
    const tint = tintFor(state.name);
    return Promise.all(parts.map(async part => {
      const tints = item.length && Array.isArray(part.tints) ? await Promise.all(part.tints.map(source => itemTint(catalog, source))) : tint;
      const transform = part.transforms?.reduce((combined, step) => combined.multiply(itemTransform(step)), identity.clone()) ?? identity;
      const gui = part.marker ? {} : item.length ? part.model.gui ?? (part.model.generated ? {} : defaultGui) : defaultGui;
      const matrix = guiTransform(gui).multiply(transform);
      const layer = await this.prepareLayer(catalog, part, matrix, tints, Boolean(item.length && part.model.guiLight === 'front'));
      if (part.fitThumbnail && layer.batches.length) {
        const bounds = extendBounds(new THREE.Box3(), [layer]);
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const scale = Math.min(1, 1 / Math.max(size.x, size.y));
        matrix.premultiply(new THREE.Matrix4().makeScale(scale, scale, scale)
          .setPosition(center.multiplyScalar(-scale)));
      }
      return layer;
    }));
  }

  async prepareLayer(catalog, part, matrix, tint, flatLight = false) {
    const batches = buildGeometry(catalog, part, tint, flatLight);
    try {
      const textured = await Promise.all(batches.map(async batch => ({ ...batch, image: await catalog.textureImage(batch.texture) })));
      return { matrix, batches: textured };
    } catch (error) {
      for (const { geometry } of batches) geometry.dispose();
      throw error;
    }
  }

  async render(layers, camera, size, { active = true, tick } = {}) {
    const meshes = new THREE.Group();
    const materials = new Map();
    try {
      if (!active) return null;
      if (!this.renderer) {
        this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        this.scene = new THREE.Scene();
      }
      if (this.renderSize !== size) {
        this.renderer.setSize(size, size, false);
        this.renderSize = size;
      }
      for (const { matrix, batches } of layers) {
        for (const batch of batches) {
          const key = materialKey(batch);
          if (!materials.has(key)) {
            const material = new THREE.MeshBasicMaterial({ vertexColors: true });
            const source = batch.image;
            const player = tick !== undefined && source.animation ? createTexturePlayer(source.animation) : null;
            player?.update(tick);
            const texture = new THREE.CanvasTexture();
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.magFilter = THREE.NearestFilter;
            texture.minFilter = THREE.NearestMipmapLinearFilter;
            const { forceTranslucent, doubleSided } = batch;
            const entry = { material, texture, forceTranslucent, doubleSided };
            applyTexture(entry, { ...source, image: player?.image ?? source.image });
            materials.set(key, entry);
          }
          const mesh = new THREE.Mesh(batch.geometry, materials.get(key).material);
          mesh.matrixAutoUpdate = false;
          mesh.matrix.copy(matrix);
          meshes.add(mesh);
        }
      }
      this.scene.add(meshes);
      this.renderer.render(this.scene, camera);
      const snapshot = document.createElement('canvas');
      snapshot.width = snapshot.height = size;
      snapshot.getContext('2d').drawImage(this.renderer.domElement, 0, 0);
      if (++this.rendered % 12 === 0) await yieldToUi();
      return snapshot;
    } finally {
      this.scene?.remove(meshes);
      for (const { batches } of layers) for (const { geometry } of batches) geometry.dispose();
      for (const { material, texture } of materials.values()) {
        material.dispose();
        texture.dispose();
      }
    }
  }
}
