import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { boxBetween, boundsOf, MAX_COORDINATE } from './scene.js';
import { applyTexture, buildGeometry, materialKey, tintFor } from './model-geometry.js';

const Y_UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
const VIEWS = { isometric: [1.32, 1.02, 1.65], front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0.0002] };
const chunkKey = pos => pos.map(n => Math.floor(n / 16)).join(',');

function workGrid() {
  const geometry = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  const material = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: {
      anchor: { value: new THREE.Vector2() }, distance: { value: 26 },
      fine: { value: new THREE.Color('#536375') }, major: { value: new THREE.Color('#71869c') },
    },
    vertexShader: `
      varying vec2 point;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        point = world.xz;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      varying vec2 point;
      uniform vec2 anchor;
      uniform float distance;
      uniform vec3 fine;
      uniform vec3 major;
      float lineGrid(vec2 p, float stepSize) {
        vec2 coord = p / stepSize;
        vec2 pixel = max(vec2(0.00001), fwidth(coord));
        vec2 edges = abs(fract(coord - 0.5) - 0.5) / pixel;
        return (1.0 - clamp(min(edges.x, edges.y), 0.0, 1.0)) * (1.0 - smoothstep(0.28, 0.85, max(pixel.x, pixel.y)));
      }
      void main() {
        float detail = lineGrid(point, 1.0) * 0.56;
        float emphasis = lineGrid(point, 5.0) * 0.73;
        float fade = 1.0 - smoothstep(distance * 0.32, distance, length(point - anchor));
        gl_FragColor = vec4(mix(fine, major, emphasis), max(detail, emphasis) * fade);
        #include <colorspace_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = 1;
  return mesh;
}

function outline(color) {
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const geometry = new THREE.EdgesGeometry(cube);
  cube.dispose();
  const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.94, depthTest: false, depthWrite: false });
  const line = new THREE.LineSegments(geometry, material);
  line.visible = false;
  line.renderOrder = 4;
  return line;
}

function showBox(object, box) {
  object.visible = Boolean(box);
  if (!box) return;
  object.position.fromArray(box.min.map((min, i) => min + box.size[i] / 2));
  object.scale.fromArray(box.size.map(n => n + 0.014));
}

export class Viewport {
  constructor(host, build, catalog, callbacks) {
    this.host = host;
    this.build = build;
    this.catalog = catalog;
    this.callbacks = callbacks;
    this.world = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.05, 4096);
    this.camera.position.set(14, 10, 17);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.canvas = this.renderer.domElement;
    this.canvas.setAttribute('aria-label', '3D 方块场景');
    host.prepend(this.canvas);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.75;
    this.controls.maxDistance = 4_000_000;
    this.controls.addEventListener('change', () => this.invalidate());
    this.controls.addEventListener('start', () => { this.dragging = true; this.hoverOutline.visible = false; this.invalidate(); });
    this.controls.addEventListener('end', () => { this.dragging = false; this.invalidate(); });

    this.grid = workGrid();
    this.group = new THREE.Group();
    this.hoverOutline = outline('#ffd28b');
    this.selectionOutline = outline('#64d3cb');
    this.world.add(this.grid, this.group, this.hoverOutline, this.selectionOutline);
    this.chunks = new Map();
    this.views = new Map();
    this.models = new Map();
    this.materials = new Map();
    this.layer = 0;
    this.raycaster = new THREE.Raycaster();
    this.floor = new THREE.Plane(Y_UP, 0);

    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.canvas.addEventListener('pointermove', event => {
      this.samplePointer = [event.clientX, event.clientY];
      this.invalidate();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.samplePointer = null;
      this.hoverOutline.visible = false;
      this.callbacks.hover?.(null);
      this.invalidate();
    });
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button === 0) this.pointerStart = [event.clientX, event.clientY];
    });
    this.canvas.addEventListener('pointerup', event => {
      if (event.button !== 0 || !this.pointerStart) return;
      const [x, y] = this.pointerStart;
      this.pointerStart = null;
      if (Math.hypot(event.clientX - x, event.clientY - y) <= 5) this.callbacks.click?.(this.pick(event.clientX, event.clientY), event);
    });
    this.canvas.addEventListener('pointercancel', () => { this.pointerStart = null; });

    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    build.onChange(change => this.sceneChanged(change));
    this.rebuild();
    this.frame('isometric');
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    if (this.nextFrame) return;
    this.nextFrame = requestAnimationFrame(() => {
      this.nextFrame = null;
      if (this.samplePointer && !this.dragging) this.callbacks.hover?.(this.pick(...this.samplePointer));
      this.render();
    });
  }

  render() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.025, distance / 1000);
    const far = Math.max(4096, distance * 12);
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.grid.position.set(this.controls.target.x, this.layer - 0.009, this.controls.target.z);
    this.grid.scale.setScalar(Math.max(25, distance * 1.25));
    this.grid.material.uniforms.anchor.value.set(this.grid.position.x, this.grid.position.z);
    this.grid.material.uniforms.distance.value = this.grid.scale.x;
    this.renderer.render(this.world, this.camera);
    this.callbacks.orientation?.(this.camera.quaternion);
  }

  setCatalog(catalog) {
    this.catalog = catalog;
    this.clearViews();
    for (const geometries of this.models.values()) for (const { geometry } of geometries) geometry.dispose();
    for (const { material, texture } of this.materials.values()) {
      material.dispose();
      texture.dispose();
    }
    this.models.clear();
    this.materials.clear();
    this.rebuild();
  }

  sceneChanged(change) {
    if (change.reset) {
      this.rebuild();
      return;
    }
    const dirty = new Set();
    for (const [key, { before, after }] of change.changes ?? []) {
      const chunk = chunkKey((before ?? after).pos);
      const block = this.build.blocks.get(key);
      if (block) {
        if (!this.chunks.has(chunk)) this.chunks.set(chunk, new Map());
        this.chunks.get(chunk).set(key, block);
      } else this.chunks.get(chunk)?.delete(key);
      dirty.add(chunk);
    }
    for (const key of dirty) this.rebuildChunk(key);
    this.updateSelection();
  }

  clearViews() {
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
  }

  disposeView(view) {
    for (const mesh of view.children) mesh.dispose();
    this.group.remove(view);
  }

  rebuild() {
    this.clearViews();
    this.chunks.clear();
    for (const [key, block] of this.build.blocks) {
      const chunk = chunkKey(block.pos);
      if (!this.chunks.has(chunk)) this.chunks.set(chunk, new Map());
      this.chunks.get(chunk).set(key, block);
    }
    for (const key of this.chunks.keys()) this.rebuildChunk(key);
    this.updateSelection();
  }

  rebuildChunk(key) {
    const old = this.views.get(key);
    if (old) { this.disposeView(old); this.views.delete(key); }
    const blocks = this.chunks.get(key);
    if (!blocks?.size) { this.chunks.delete(key); return; }
    const batches = new Map();
    for (const { pos, state } of blocks.values()) {
      const tint = tintFor(state.name);
      for (const part of this.catalog.parts(state, pos)) {
        const id = `${part.key}|${tint.getHexString()}`;
        if (!batches.has(id)) batches.set(id, { part, tint, cells: [] });
        batches.get(id).cells.push(pos);
      }
    }
    const view = new THREE.Group();
    for (const [id, { part, tint, cells }] of batches) {
      if (!this.models.has(id)) this.models.set(id, buildGeometry(this.catalog, part, tint));
      const matrix = new THREE.Matrix4();
      for (const batch of this.models.get(id)) {
        const mesh = new THREE.InstancedMesh(batch.geometry, this.material(batch), cells.length);
        cells.forEach((pos, index) => mesh.setMatrixAt(index, matrix.makeTranslation(...pos)));
        mesh.userData.cells = cells;
        view.add(mesh);
      }
    }
    this.views.set(key, view);
    this.group.add(view);
  }

  material(batch) {
    const key = materialKey(batch);
    if (this.materials.has(key)) return this.materials.get(key).material;
    const catalog = this.catalog;
    const texture = new THREE.CanvasTexture();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4);
    const material = new THREE.MeshBasicMaterial({ visible: false, vertexColors: true });
    const entry = { material, texture, forceTranslucent: batch.forceTranslucent };
    const ready = catalog.textureImage(batch.texture).then(image => {
      if (catalog !== this.catalog) return;
      applyTexture(entry, image);
      material.visible = true;
      this.invalidate();
    });
    this.materials.set(key, { ...entry, ready });
    return material;
  }

  updateSelection() {
    showBox(this.selectionOutline, boundsOf(this.build.selected));
    this.invalidate();
  }

  setHover(a, b = a, color = '#ffd28b') {
    showBox(this.hoverOutline, a && b ? boxBetween(a, b) : null);
    this.hoverOutline.material.color.set(color);
  }

  setLayer(layer) {
    this.layer = layer;
    this.floor.constant = -layer;
    this.invalidate();
  }

  toggleGrid() {
    this.grid.visible = !this.grid.visible;
    this.invalidate();
    return this.grid.visible;
  }

  pick(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const cursor = new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.camera.updateMatrixWorld();
    this.group.updateMatrixWorld();
    this.raycaster.setFromCamera(cursor, this.camera);
    const hit = this.raycaster.intersectObject(this.group, true).find(({ object }) => object.material.visible);
    if (hit) {
      const cell = hit.object.userData.cells[hit.instanceId];
      const normal = hit.face.normal.toArray();
      const direction = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      const adjacent = cell.map((n, i) => n + (i === direction ? Math.sign(normal[i]) : 0));
      return { cell, place: adjacent };
    }
    const floor = this.raycaster.ray.intersectPlane(this.floor, new THREE.Vector3());
    if (!floor || floor.distanceTo(this.camera.position) > 350 && floor.distanceTo(this.controls.target) > this.camera.position.distanceTo(this.controls.target) * 2) return null;
    const place = [Math.floor(floor.x), this.layer, Math.floor(floor.z)];
    return place.every(n => Math.abs(n) <= MAX_COORDINATE) ? { cell: null, place } : null;
  }

  frame(preset) {
    if (!Object.hasOwn(VIEWS, preset)) throw new Error('未知视角。');
    const bounds = this.build.bounds ?? { min: [-3, -1, -3], max: [3, 2, 3], size: [7, 4, 7] };
    const target = new THREE.Vector3(...bounds.min.map((n, i) => n + bounds.size[i] / 2));
    const eye = new THREE.Vector3(...VIEWS[preset]).normalize();
    const right = Y_UP.clone().cross(eye).normalize();
    const up = eye.clone().cross(right);
    const vFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    let distance = 3;
    for (const x of [bounds.min[0], bounds.max[0] + 1]) {
      for (const y of [bounds.min[1], bounds.max[1] + 1]) {
        for (const z of [bounds.min[2], bounds.max[2] + 1]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          const h = Math.abs(corner.dot(right)) / (vFov * this.camera.aspect * 0.91);
          const v = Math.abs(corner.dot(up)) / (vFov * 0.83);
          distance = Math.max(distance, corner.dot(eye) + Math.max(h, v));
        }
      }
    }
    this.camera.position.copy(target).addScaledVector(eye, distance);
    this.controls.target.copy(target);
    this.controls.update();
    this.invalidate();
  }

  setCamera(position, target) {
    for (const vector of [position, target]) {
      if (!Array.isArray(vector) || vector.length !== 3 || vector.some(n => !Number.isFinite(n) || Math.abs(n) > 5_000_000)) throw new Error('相机需要有效的三维坐标。');
    }
    const camera = new THREE.Vector3(...position);
    const lookAt = new THREE.Vector3(...target);
    if (camera.distanceToSquared(lookAt) < 0.5625) throw new Error('相机距离目标至少 0.75 格。');
    this.camera.position.copy(camera);
    this.controls.target.copy(lookAt);
    this.controls.update();
    this.invalidate();
  }

  cameraInfo() {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray(), fov: this.camera.fov };
  }

  blockPreviewCamera(followCamera) {
    const camera = new THREE.PerspectiveCamera(this.camera.fov, 1);
    if (followCamera) {
      camera.quaternion.copy(this.camera.quaternion);
    } else {
      camera.position.fromArray(VIEWS.isometric);
      camera.lookAt(ZERO);
    }
    return camera;
  }

  async capture(maxWidth = 1440) {
    if (!Number.isInteger(maxWidth) || maxWidth < 256 || maxWidth > 1920) throw new Error('截图宽度需要是 256 至 1920 的整数。');
    await Promise.all([...this.materials.values()].map(({ ready }) => ready));
    this.hoverOutline.visible = false;
    this.render();
    const scale = Math.min(1, maxWidth / this.canvas.width);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(this.canvas.width * scale));
    canvas.height = Math.max(1, Math.round(this.canvas.height * scale));
    const ctx = canvas.getContext('2d');
    const [w, h] = [canvas.width, canvas.height];
    const bg = ctx.createRadialGradient(w * 0.53, h * 0.44, 0, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.62);
    bg.addColorStop(0, '#28343f');
    bg.addColorStop(1, '#181e27');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this.canvas, 0, 0, w, h);
    this.invalidate();
    return { data: canvas.toDataURL('image/png').split(',')[1], width: w, height: h };
  }
}

export function drawCompass(canvas, quaternion) {
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const axes = [
    ['X', '#f19a8d', new THREE.Vector3(1, 0, 0)],
    ['Y', '#a0d9a6', Y_UP.clone()],
    ['Z', '#95bdf6', new THREE.Vector3(0, 0, 1)],
  ];
  const inverse = quaternion.clone().invert();
  axes.forEach(([, , vector]) => vector.applyQuaternion(inverse));
  axes.sort((a, b) => a[2].z - b[2].z);
  context.clearRect(0, 0, size, size);
  context.lineWidth = 2;
  for (const [label, color, { x, y, z }] of axes) {
    const dx = center + x * size * 0.34;
    const dy = center - y * size * 0.34;
    context.globalAlpha = z < -0.01 ? 0.54 : 1;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(center, center);
    context.lineTo(dx, dy);
    context.stroke();
    context.beginPath();
    context.arc(dx, dy, 8, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#1c222a';
    context.font = 'bold 10px ui-monospace, monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(label, dx, dy + 0.5);
  }
  context.globalAlpha = 1;
}
