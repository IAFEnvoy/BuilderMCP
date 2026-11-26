import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { boxBetween, boundsOf, MAX_COORDINATE } from './scene.js';
import { applyTexture, buildGeometry, materialKey, tintFor } from './model-geometry.js';
import { createTexturePlayer } from './texture-animation.js';

const Y_UP = new THREE.Vector3(0, 1, 0);
const ZERO = new THREE.Vector3();
export const DEFAULT_CAMERA_PRESET = 'angled';
const VIEWS = {
  angled: [1.32, 1.02, 1.65], isometric: [1, 1, 1],
  front: [0, 0, 1], right: [1, 0, 0], top: [0, 1, 0.0002],
};
const FIELD_OF_VIEW = 35;
const HALF_FOV_TANGENT = Math.tan(THREE.MathUtils.degToRad(FIELD_OF_VIEW / 2));
const MIN_CAMERA_DISTANCE = 0.75;
const MAX_CAMERA_DISTANCE = 4_000_000;
const CLICK_TOLERANCE = 5;
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
    this.perspectiveCamera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.05, 4096);
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 4096);
    this.camera = this.perspectiveCamera;
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
    this.controls.minDistance = MIN_CAMERA_DISTANCE;
    this.controls.maxDistance = MAX_CAMERA_DISTANCE;
    this.controls.minZoom = 1 / (MAX_CAMERA_DISTANCE * HALF_FOV_TANGENT);
    this.controls.maxZoom = 1 / (MIN_CAMERA_DISTANCE * HALF_FOV_TANGENT);
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
    this.textures = new Map();
    this.animatedTextures = new Set();
    this.markers = new Set();
    this.markerRotation = new THREE.Quaternion(0, 0, 0, 0);
    this.replaying = false;
    this.layer = 0;
    this.raycaster = new THREE.Raycaster();
    this.floor = new THREE.Plane(Y_UP, 0);

    this.canvas.addEventListener('contextmenu', event => event.preventDefault());
    this.canvas.addEventListener('pointermove', event => {
      this.samplePointer = [event.clientX, event.clientY];
      const start = this.pointerStart;
      if (start?.button === 1 && start.id === event.pointerId) {
        // Keep OrbitControls from moving the camera until this is a drag.
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= CLICK_TOLERANCE) event.stopPropagation();
        else this.pointerStart = null;
      }
      this.invalidate();
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.samplePointer = null;
      this.hoverOutline.visible = false;
      this.callbacks.hover?.(null);
      this.invalidate();
    });
    this.canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      if (event.button === 1) event.preventDefault();
      this.pointerStart = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY };
    });
    this.canvas.addEventListener('pointerup', event => {
      const start = this.pointerStart;
      if (!start || start.id !== event.pointerId) return;
      this.pointerStart = null;
      if (start.button === event.button && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= CLICK_TOLERANCE) {
        this.callbacks.click?.(this.pick(event.clientX, event.clientY), event);
      }
    });
    this.canvas.addEventListener('pointercancel', () => { this.pointerStart = null; });

    this.resize();
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(host);
    build.onChange(change => this.sceneChanged(change));
    this.rebuild();
    this.frame(DEFAULT_CAMERA_PRESET);
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    this.perspectiveCamera.aspect = aspect;
    this.perspectiveCamera.updateProjectionMatrix();
    this.orthographicCamera.left = -aspect;
    this.orthographicCamera.right = aspect;
    this.orthographicCamera.updateProjectionMatrix();
    this.invalidate();
  }

  invalidate() {
    this.viewDirty = true;
    this.requestFrame();
  }

  requestFrame() {
    if (this.nextFrame) return;
    this.nextFrame = requestAnimationFrame(now => {
      this.nextFrame = null;
      const changed = this.advanceTextures(now);
      if (this.viewDirty) {
        this.viewDirty = false;
        if (this.samplePointer && !this.dragging) this.callbacks.hover?.(this.pick(...this.samplePointer));
        this.render();
      } else if (changed) {
        this.renderer.render(this.world, this.camera);
      }
      if (this.animatedTextures.size) this.requestFrame();
    });
  }

  advanceTextures(now) {
    if (!this.animatedTextures.size) return false;
    const tick = this.catalog.animationTick(now);
    let changed = false;
    for (const { texture, player } of this.animatedTextures) {
      if (player.update(tick)) {
        texture.needsUpdate = true;
        changed = true;
      }
    }
    return changed;
  }

  updateClippingPlanes(distance = this.controls.getDistance()) {
    const near = this.camera.isOrthographicCamera ? 0.025 : Math.max(0.025, distance / 1000);
    const far = Math.max(4096, distance * 12);
    if (near !== this.camera.near || far !== this.camera.far) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  get viewDistance() {
    return this.camera.isOrthographicCamera ? 1 / (this.camera.zoom * HALF_FOV_TANGENT) : this.controls.getDistance();
  }

  render() {
    this.updateClippingPlanes();
    this.updateMarkers();
    const distance = this.viewDistance;
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
    for (const { material } of this.materials.values()) material.dispose();
    for (const { texture } of this.textures.values()) texture.dispose();
    this.models.clear();
    this.materials.clear();
    this.textures.clear();
    for (const key of this.chunks.keys()) this.rebuildChunk(key);
    this.invalidate();
  }

  sceneChanged({ reset, changes, side }) {
    if (this.replaying) return;
    if (reset) {
      this.rebuild();
      return;
    }
    if (changes) this.updateBlocks(changes, side);
    this.updateSelection();
  }

  updateBlocks(changes, side) {
    const dirty = new Set();
    for (const [key, change] of changes) {
      const chunk = chunkKey((change.before ?? change.after).pos);
      const block = change[side];
      if (block) {
        if (!this.chunks.has(chunk)) this.chunks.set(chunk, new Map());
        this.chunks.get(chunk).set(key, block);
      } else this.chunks.get(chunk)?.delete(key);
      dirty.add(chunk);
    }
    for (const key of dirty) this.rebuildChunk(key);
  }

  startReplay(blocks) {
    this.replaying = true;
    this.host.inert = true;
    this.controls.enabled = false;
    this.dragging = false;
    this.pointerStart = this.samplePointer = null;
    this.hoverOutline.visible = false;
    this.rebuild(blocks);
  }

  replayStep({ changes, side }) {
    this.updateBlocks(changes, side);
    this.invalidate();
  }

  stopReplay() {
    this.replaying = false;
    this.host.inert = false;
    this.controls.enabled = true;
    this.rebuild();
  }

  clearViews() {
    for (const view of this.views.values()) this.disposeView(view);
    this.views.clear();
  }

  disposeView(view) {
    for (const mesh of view.children) {
      this.markers.delete(mesh);
      const source = mesh.userData.textureSource;
      if (--source.users === 0) this.animatedTextures.delete(source);
      mesh.dispose();
    }
    this.group.remove(view);
  }

  rebuild(blocks = this.build.blocks) {
    this.clearViews();
    this.chunks.clear();
    for (const [key, block] of blocks) {
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
    for (const { pos, state, blockEntity } of blocks.values()) {
      const tint = tintFor(state.name);
      for (const part of this.catalog.parts(state, pos, blockEntity)) {
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
        const { material, source } = this.material(batch);
        source.users++;
        if (source.player) this.animatedTextures.add(source);
        const mesh = new THREE.InstancedMesh(batch.geometry, material, cells.length);
        cells.forEach((pos, index) => mesh.setMatrixAt(index, matrix.makeTranslation(...pos)));
        mesh.userData.cells = cells;
        mesh.userData.textureSource = source;
        if (part.marker) {
          this.markers.add(mesh);
          this.markerRotation.set(0, 0, 0, 0);
        }
        view.add(mesh);
      }
    }
    this.views.set(key, view);
    this.group.add(view);
  }

  material(batch) {
    const key = materialKey(batch);
    if (this.materials.has(key)) return this.materials.get(key);
    const source = this.textureSource(batch.texture);
    const material = new THREE.MeshBasicMaterial({ visible: false, vertexColors: true });
    const entry = { material, source, texture: source.texture, forceTranslucent: batch.forceTranslucent };
    entry.ready = source.ready.then(image => {
      if (!image || this.materials.get(key) !== entry) return;
      applyTexture(entry, { ...image, image: source.player?.image ?? image.image });
      material.visible = true;
      if (source.users) this.invalidate();
    });
    this.materials.set(key, entry);
    return entry;
  }

  textureSource(key) {
    if (this.textures.has(key)) return this.textures.get(key);
    const catalog = this.catalog;
    const texture = new THREE.CanvasTexture();
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.anisotropy = Math.min(this.renderer.capabilities.getMaxAnisotropy(), 4);
    const source = { texture, users: 0, player: null };
    source.ready = catalog.textureImage(key).then(image => {
      if (this.textures.get(key) !== source) return null;
      if (image.animation) {
        source.player = createTexturePlayer(image.animation);
        source.player.update(catalog.animationTick());
        if (source.users) this.animatedTextures.add(source);
      }
      return image;
    });
    this.textures.set(key, source);
    return source;
  }

  updateSelection() {
    showBox(this.selectionOutline, this.replaying ? null : boundsOf(this.build.selected));
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

  updateMarkers() {
    const rotation = this.camera.quaternion;
    if (!this.markers.size || this.markerRotation.equals(rotation)) return;
    this.markerRotation.copy(rotation);
    const offset = new THREE.Vector3(0.5, 0.5, 0.5);
    offset.sub(new THREE.Vector3(0.5, 0.5, 0.5).applyQuaternion(rotation));
    const matrix = new THREE.Matrix4().makeRotationFromQuaternion(rotation);
    for (const mesh of this.markers) {
      mesh.userData.cells.forEach(([x, y, z], index) => {
        mesh.setMatrixAt(index, matrix.setPosition(x + offset.x, y + offset.y, z + offset.z));
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.boundingSphere = null;
    }
  }

  pick(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const cursor = new THREE.Vector2((x - rect.left) / rect.width * 2 - 1, -(y - rect.top) / rect.height * 2 + 1);
    this.camera.updateMatrixWorld();
    this.updateMarkers();
    this.group.updateMatrixWorld();
    this.raycaster.setFromCamera(cursor, this.camera);
    const hit = this.raycaster.intersectObject(this.group, true).find(({ object }) => object.material.visible);
    if (hit) {
      const cell = hit.object.userData.cells[hit.instanceId];
      const normal = (this.markers.has(hit.object)
        ? hit.face.normal.clone().applyQuaternion(this.camera.quaternion)
        : hit.face.normal).toArray();
      const direction = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs)));
      const adjacent = cell.map((n, i) => n + (i === direction ? Math.sign(normal[i]) : 0));
      return { cell, place: adjacent };
    }
    const floor = this.raycaster.ray.intersectPlane(this.floor, new THREE.Vector3());
    if (!floor || floor.distanceTo(this.camera.position) > 350 && floor.distanceTo(this.controls.target) > this.viewDistance * 2) return null;
    const place = [Math.floor(floor.x), this.layer, Math.floor(floor.z)];
    return place.every(n => Math.abs(n) <= MAX_COORDINATE) ? { cell: null, place } : null;
  }

  get projection() {
    return this.camera.isOrthographicCamera ? 'orthographic' : 'perspective';
  }

  setProjection(projection) {
    if (this.replaying) throw new Error('回放期间相机视角固定。');
    if (projection !== 'perspective' && projection !== 'orthographic') throw new Error('未知投影方式。');
    if (projection === this.projection) return;

    // Match the visible height at the orbit target when switching projection.
    const distance = this.viewDistance;
    const offset = this.camera.position.clone().sub(this.controls.target);
    const orthographic = projection === 'orthographic';
    this.camera = orthographic ? this.orthographicCamera : this.perspectiveCamera;
    this.camera.position.copy(this.controls.target).add(offset.setLength(distance));
    if (orthographic) this.camera.zoom = 1 / (distance * HALF_FOV_TANGENT);
    this.camera.updateProjectionMatrix();
    this.controls.object = this.camera;
    this.controls.update();
    this.invalidate();
  }

  frame(preset, projection = preset === 'isometric' ? 'orthographic' : this.projection) {
    if (!Object.hasOwn(VIEWS, preset)) throw new Error('未知视角。');
    this.setProjection(projection);
    const bounds = this.build.bounds ?? { min: [-3, -1, -3], max: [3, 2, 3], size: [7, 4, 7] };
    const target = new THREE.Vector3(...bounds.min.map((n, i) => n + bounds.size[i] / 2));
    const eye = new THREE.Vector3(...VIEWS[preset]).normalize();
    const right = Y_UP.clone().cross(eye).normalize();
    const up = eye.clone().cross(right);
    const aspect = this.perspectiveCamera.aspect;
    const orthographic = this.camera.isOrthographicCamera;
    let distance = 3;
    let halfHeight = distance * HALF_FOV_TANGENT;
    for (const x of [bounds.min[0], bounds.max[0] + 1]) {
      for (const y of [bounds.min[1], bounds.max[1] + 1]) {
        for (const z of [bounds.min[2], bounds.max[2] + 1]) {
          const corner = new THREE.Vector3(x, y, z).sub(target);
          const widthFit = Math.abs(corner.dot(right)) / (aspect * 0.91);
          const heightFit = Math.abs(corner.dot(up)) / 0.83;
          const extent = Math.max(widthFit, heightFit);
          halfHeight = Math.max(halfHeight, extent);
          const requiredDistance = orthographic ? corner.length() + 1 : corner.dot(eye) + extent / HALF_FOV_TANGENT;
          distance = Math.max(distance, requiredDistance);
        }
      }
    }
    if (orthographic) {
      this.camera.zoom = 1 / halfHeight;
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(target).addScaledVector(eye, distance);
    this.controls.target.copy(target);
    this.controls.update();
    this.invalidate();
  }

  setCamera(position, target, projection = this.projection) {
    for (const vector of [position, target]) {
      if (!Array.isArray(vector) || vector.length !== 3 || vector.some(n => !Number.isFinite(n) || Math.abs(n) > 5_000_000)) throw new Error('相机需要有效的三维坐标。');
    }
    const camera = new THREE.Vector3(...position);
    const lookAt = new THREE.Vector3(...target);
    const distance = camera.distanceTo(lookAt);
    if (distance < MIN_CAMERA_DISTANCE) throw new Error('相机距离目标至少 0.75 格。');
    this.setProjection(projection);
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = 1 / (Math.min(distance, MAX_CAMERA_DISTANCE) * HALF_FOV_TANGENT);
      this.camera.updateProjectionMatrix();
    }
    this.camera.position.copy(camera);
    this.controls.target.copy(lookAt);
    this.controls.update();
    this.invalidate();
  }

  cameraInfo() {
    return {
      position: this.camera.position.toArray(), target: this.controls.target.toArray(), projection: this.projection,
      ...(this.camera.isOrthographicCamera ? { height: 2 / this.camera.zoom } : { fov: this.camera.fov }),
    };
  }

  blockPreviewCamera(followCamera) {
    const camera = followCamera && this.camera.isOrthographicCamera
      ? new THREE.OrthographicCamera()
      : new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1);
    if (followCamera) {
      camera.quaternion.copy(this.camera.quaternion);
    } else {
      camera.position.fromArray(VIEWS[DEFAULT_CAMERA_PRESET]);
      camera.lookAt(ZERO);
    }
    return camera;
  }

  async capture(maxWidth = 1440, { transparent = false } = {}) {
    if (!Number.isInteger(maxWidth) || maxWidth < 256 || maxWidth > 1920) throw new Error('截图宽度需要是 256 至 1920 的整数。');
    await Promise.all([...this.materials.values()].map(({ ready }) => ready));
    this.advanceTextures();
    if (transparent) return this.captureBuilding(maxWidth);
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

  captureBuilding(maxEdge) {
    const { x: width, y: height } = this.renderer.getSize(new THREE.Vector2());
    const scale = maxEdge / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    this.updateClippingPlanes();
    this.drawBuilding(canvas, this.camera);
    return { data: canvas.toDataURL('image/png').split(',')[1], width: canvas.width, height: canvas.height };
  }

  createReplayCapture(maxEdge) {
    const { x: width, y: height } = this.renderer.getSize(new THREE.Vector2());
    const evenEdge = maxEdge - maxEdge % 2;
    const scale = evenEdge / Math.max(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, 2 * Math.round(width * scale / 2));
    canvas.height = Math.max(2, 2 * Math.round(height * scale / 2));
    this.updateClippingPlanes();
    const camera = this.camera.clone();
    const start = performance.now();
    const draw = async (elapsed, signal) => {
      await Promise.all([...this.materials.values()].map(({ ready }) => ready));
      signal.throwIfAborted();
      this.advanceTextures(start + elapsed);
      this.drawBuilding(canvas, camera, '#202934');
    };
    return { canvas, draw };
  }

  drawBuilding(canvas, camera, background) {
    const { x: width, y: height } = this.renderer.getSize(new THREE.Vector2());
    const pixelRatio = this.renderer.getPixelRatio();
    // Render the building group directly to preserve alpha and exclude editor guides.
    this.renderer.setDrawingBufferSize(canvas.width, canvas.height, 1);
    for (const mesh of this.markers) mesh.visible = false;
    try {
      this.renderer.render(this.group, camera);
      const context = canvas.getContext('2d');
      if (background) {
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.drawImage(this.canvas, 0, 0);
    } finally {
      for (const mesh of this.markers) mesh.visible = true;
      this.renderer.setDrawingBufferSize(width, height, pixelRatio);
      this.invalidate();
    }
  }
}

export function drawCompass(canvas, quaternion, endpoints) {
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const center = size / 2;
  const axes = [
    ['right', 'X', '#f19a8d', new THREE.Vector3(1, 0, 0)],
    ['top', 'Y', '#a0d9a6', Y_UP.clone()],
    ['front', 'Z', '#95bdf6', new THREE.Vector3(0, 0, 1)],
  ];
  const inverse = quaternion.clone().invert();
  axes.forEach(([, , , vector]) => vector.applyQuaternion(inverse));
  axes.sort((a, b) => a[3].z - b[3].z);
  context.clearRect(0, 0, size, size);
  context.lineWidth = 2;
  for (const [index, [view, label, color, { x, y, z }]] of axes.entries()) {
    const dx = center + x * size * 0.34;
    const dy = center - y * size * 0.34;
    const endpoint = endpoints.get(view);
    endpoint.style.left = `${dx / size * 100}%`;
    endpoint.style.top = `${dy / size * 100}%`;
    endpoint.style.zIndex = String(index + 1);
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
