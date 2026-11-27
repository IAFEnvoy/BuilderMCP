import * as THREE from 'three';
import { sheetForFace } from './connected-textures.js';

const corners = {
  down: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  up: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  north: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  south: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  west: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  east: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
};
const faces = Object.keys(corners);
const axes = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const normals = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const faceAxes = Object.fromEntries(faces.map(face => {
  const [topLeft, bottomLeft, , topRight] = corners[face].map(vertex => new THREE.Vector3(...vertex));
  return [face, { right: topRight.sub(topLeft), up: topLeft.clone().sub(bottomLeft) }];
}));
const center = new THREE.Vector3(8, 8, 8);
const white = new THREE.Color('#ffffff');
const grass = new THREE.Color('#91bd59');
const foliage = new THREE.Color(0x48b518);
const spruce = new THREE.Color(0x619961);
const birch = new THREE.Color(0x80a755);
const water = new THREE.Color('#3f76e4');
const radians = Math.PI / 180;
const missingMaterial = { texture: Symbol('missing texture'), forceTranslucent: false };

const numericVec = (value, size) => Array.isArray(value) && value.length === size && value.every(Number.isFinite);

function defaultUv(direction, [x0, y0, z0], [x1, y1, z1]) {
  switch (direction) {
    case 'down': return [x0, 16 - z1, x1, 16 - z0];
    case 'up': return [x0, z0, x1, z1];
    case 'north': return [16 - x1, 16 - y1, 16 - x0, 16 - y0];
    case 'south': return [x0, 16 - y1, x1, 16 - y0];
    case 'west': return [z0, 16 - y1, z1, 16 - y0];
    case 'east': return [16 - z1, 16 - y1, 16 - z0, 16 - y0];
  }
}

function lockUv(direction, rotation) {
  const normal = new THREE.Vector3(...normals[direction]).applyQuaternion(rotation);
  const facing = faces.find(face => normal.dot(new THREE.Vector3(...normals[face])) > 0.99);
  if (!facing) return null;
  const source = faceAxes[direction];
  const target = faceAxes[facing];
  const right = source.right.clone().applyQuaternion(rotation);
  const up = source.up.clone().applyQuaternion(rotation);
  // Map UVs into the destination face's frame, with V increasing down the texture.
  return [right.dot(target.right), right.dot(target.up), up.dot(target.right), up.dot(target.up)].map(Math.round);
}

function elementTransform(rotation) {
  if (!numericVec(rotation?.origin, 3)) return null;
  const axis = axes[rotation.axis];
  const quaternion = new THREE.Quaternion();
  if (axis?.isVector3 && Number.isFinite(rotation.angle)) {
    quaternion.setFromAxisAngle(axis, rotation.angle * radians);
  } else {
    const angles = [rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0];
    if (!angles.every(Number.isFinite)) return null;
    quaternion.setFromEuler(new THREE.Euler(...angles.map(n => n * radians), 'ZYX'));
  }
  const scale = new THREE.Vector3(1, 1, 1);
  if (rotation.rescale) {
    for (const [index, direction] of Object.values(axes).entries()) {
      const rotated = direction.clone().applyQuaternion(quaternion);
      scale.setComponent(index, 1 / Math.max(Math.abs(rotated.x), Math.abs(rotated.y), Math.abs(rotated.z)));
    }
  }
  const pivot = new THREE.Vector3(...rotation.origin);
  return new THREE.Matrix4().compose(pivot, quaternion, scale)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
}

function modelRotation({ x = 0, y = 0, z = 0 }) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(-x * radians, -y * radians, -z * radians, 'ZYX'));
}

function faceUvs(face, direction, from, to, uvTransform) {
  const [u0, v0, u1, v1] = numericVec(face.uv, 4) ? face.uv : defaultUv(direction, from, to);
  const corners = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
  const turn = Number.isInteger(face.rotation / 90) ? (face.rotation / 90 % 4 + 4) % 4 : 0;
  return corners.map((_, index) => {
    const [u, v] = corners[(index + turn) % 4];
    if (!uvTransform) return [u, v];
    const [a, b, c, d] = uvTransform;
    return [8 + a * (u - 8) + b * (v - 8), 8 + c * (u - 8) + d * (v - 8)];
  });
}

function cardinal(vector) {
  const values = vector.toArray();
  const snapped = values.map(Math.round);
  return snapped.every((n, i) => Math.abs(n - values[i]) < 0.001) && snapped.reduce((sum, n) => sum + Math.abs(n), 0) === 1 ? snapped : null;
}

export function connectedModelFaces(catalog, part) {
  if (!catalog.connectedSheets.size || part.marker || part.fluid) return [];
  const { model, uvlock } = part;
  const rotation = modelRotation(part);
  const connected = [];
  const interior = [];
  for (const [index, element] of model.elements.entries()) {
    if (!numericVec(element?.from, 3) || !numericVec(element?.to, 3)) continue;
    const transform = elementTransform(element.rotation);
    const fullCube = !transform && element.from.every(n => n === 0) && element.to.every(n => n === 16);
    const worldDirection = vector => {
      vector = vector.clone();
      if (transform) vector.transformDirection(transform);
      return cardinal(vector.applyQuaternion(rotation));
    };
    for (const direction of faces) {
      const face = element.faces?.[direction];
      if (!face) continue;
      const normal = worldDirection(new THREE.Vector3(...normals[direction]));
      if (!normal) continue;
      const key = index * faces.length + faces.indexOf(direction);
      const cull = fullCube && face.cullface === direction;
      const texture = catalog.textureMaterial(model, face.texture)?.texture;
      const sheet = sheetForFace(catalog, model, texture, normal, model.connectedPane);
      if (!sheet) {
        if (cull) interior.push({ key, normal, cull });
        continue;
      }
      const [topLeft, bottomLeft, , topRight] = faceUvs(face, direction, element.from, element.to, uvlock && lockUv(direction, rotation));
      const { right, up } = faceAxes[direction];
      const uAlongRight = Math.sign(topRight[0] - topLeft[0]);
      const vAlongRight = Math.sign(topLeft[1] - topRight[1]);
      const horizontal = worldDirection(uAlongRight ? right.clone().multiplyScalar(uAlongRight) : up.clone().multiplyScalar(Math.sign(topLeft[0] - bottomLeft[0])));
      const vertical = worldDirection(vAlongRight ? right.clone().multiplyScalar(vAlongRight) : up.clone().multiplyScalar(Math.sign(bottomLeft[1] - topLeft[1])));
      if (horizontal && vertical) connected.push({ key, sheet, normal, horizontal, vertical, cull });
    }
  }
  return connected.length ? connected.concat(interior) : [];
}

export function tintFor(name) {
  if (name.endsWith('spruce_leaves')) return spruce;
  if (name.endsWith('birch_leaves')) return birch;
  if (/leaves|vine/.test(name)) return foliage;
  if (/water|cauldron/.test(name)) return water;
  if (/grass|fern|sugar_cane|lily_pad/.test(name)) return grass;
  return white;
}

export function fluidOcclusion(catalog, name, parts) {
  // Resource packs provide render models, so infer occlusion from boundary cull faces.
  const overlay = /^minecraft:(?:glass|tinted_glass|ice|frosted_ice|slime_block|honey_block|\w+_stained_glass|\w+_leaves)$/.test(name);
  const nonOccluding = overlay || name === 'minecraft:spawner' || name === 'minecraft:trial_spawner';
  const spans = new Map();
  let solid = false;
  for (const part of parts) {
    if (part.marker) continue;
    const rotation = modelRotation(part);
    if (!Object.values(axes).every(axis => cardinal(axis.clone().applyQuaternion(rotation)))) continue;
    const toCell = point => new THREE.Vector3(...point).sub(center).applyQuaternion(rotation).add(center).multiplyScalar(1 / 16);
    for (const element of part.model.elements) {
      if (!numericVec(element?.from, 3) || !numericVec(element?.to, 3) || element.rotation) continue;
      const a = toCell(element.from);
      const b = toCell(element.to);
      const lo = a.clone().min(b).toArray();
      const hi = a.max(b).toArray();
      const epsilon = 1e-6;
      if (hi.some((max, i) => max - lo[i] < epsilon)) continue;
      for (const direction of faces) {
        const face = element.faces?.[direction];
        if (face?.cullface !== direction) continue;
        const normal = cardinal(new THREE.Vector3(...normals[direction]).applyQuaternion(rotation));
        const axis = normal.findIndex(Boolean);
        const side = normal[axis] > 0 ? 1 : 0;
        if (Math.abs((side ? hi : lo)[axis] - side) > epsilon) continue;
        if (lo.some((min, i) => i !== axis && i !== 1 && (min > epsilon || hi[i] < 1 - epsilon))) continue;
        solid = true;
        if (nonOccluding || catalog.textureMaterial(part.model, face.texture)?.forceTranslucent) continue;
        const facing = faces.find(direction => normals[direction][axis] === normal[axis]);
        if (!spans.has(facing)) spans.set(facing, []);
        spans.get(facing).push(axis === 1 ? [0, 1] : [Math.max(0, lo[1]), Math.min(1, hi[1])]);
      }
    }
  }
  const covered = {};
  for (const [direction, ranges] of spans) {
    let height = 0;
    for (const [start, end] of ranges.sort(([a], [b]) => a - b)) {
      if (start > height + 1e-6) break;
      height = Math.max(height, end);
    }
    covered[direction] = height > 1 - 1e-6 ? 1 : height;
  }
  return { faces: covered, solid, overlay };
}

function geometryBatch(batches, material) {
  const key = materialKey(material);
  if (!batches.has(key)) batches.set(key, { material, position: [], uv: [], color: [], indices: [] });
  return batches.get(key);
}

function finishBatches(batches) {
  return [...batches.values()].filter(batch => batch.indices.length).map(batch => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.position, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(batch.uv, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.color, 3));
    geometry.setIndex(batch.indices);
    geometry.computeBoundingSphere();
    return { ...batch.material, geometry };
  });
}

const fluidShade = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };

function buildFluidGeometry({ type, heights, angle, faces, sprites }, flatLight) {
  const batches = new Map();
  const { forceTranslucent } = sprites;
  const tint = type === 'minecraft:water' ? water : white;
  const surface = [[heights[0], heights[1]], [heights[3], heights[2]]];
  const faceInset = 0.001;
  const surfaceInset = faces.some(face => face.direction === 'up') ? faceInset : 0;
  const bottomInset = faces.some(face => face.direction === 'down') ? faceInset : 0;
  const sin = Math.sin(angle);
  const cos = Math.cos(angle);
  for (const { direction, texture, doubleSided } of faces) {
    const batch = geometryBatch(batches, { texture, forceTranslucent, doubleSided });
    const start = batch.position.length / 3;
    const [nx, , nz] = normals[direction];
    const color = tint.clone().multiplyScalar(flatLight ? 1 : fluidShade[direction]);
    const sideUvSpan = texture === sprites.still && sprites.flow === sprites.still ? 1 : 0.5;
    for (const [index, [x, top, z]] of corners[direction].entries()) {
      const y = top ? surface[x][z] - surfaceInset : bottomInset;
      let u = x;
      let v = z;
      if (nx || nz) {
        u = index < 2 ? sideUvSpan : 0;
        v = (1 - y) * sideUvSpan;
      } else if (direction === 'up' && angle !== null) {
        u = 0.5 + (x - 0.5) / 2 * cos + (z - 0.5) / 2 * sin;
        v = 0.5 + (z - 0.5) / 2 * cos - (x - 0.5) / 2 * sin;
      }
      batch.position.push(x - nx * faceInset, y, z - nz * faceInset);
      batch.uv.push(u, 1 - v);
      batch.color.push(color.r, color.g, color.b);
    }
    batch.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }
  return finishBatches(batches);
}

export function buildGeometry(catalog, part, tint = white, flatLight = false, patches) {
  if (part.fluid) return buildFluidGeometry(part.fluid, flatLight);
  const { model, uvlock } = part;
  const rotation = modelRotation(part);
  const uvTransforms = uvlock ? Object.fromEntries(faces.map(face => [face, lockUv(face, rotation)])) : {};
  const batches = new Map();
  for (const [elementIndex, element] of model.elements.entries()) {
    if (!numericVec(element?.from, 3) || !numericVec(element?.to, 3)) continue;
    const { from, to } = element;
    if ([...from, ...to].some(value => Math.abs(value) > 512)) continue;
    const transform = elementTransform(element.rotation);
    for (const [faceIndex, direction] of faces.entries()) {
      const face = element.faces?.[direction];
      if (!face) continue;
      const patch = patches?.get(elementIndex * faces.length + faceIndex);
      if (patch === false) continue;
      const resolved = catalog.textureMaterial(model, face.texture);
      const material = patch ? { ...resolved, texture: patch.sheet.texture }
        : catalog.textures.has(resolved?.texture) ? resolved : missingMaterial;
      const batch = geometryBatch(batches, material);
      const start = batch.position.length / 3;
      const vertices = corners[direction].map(bits => {
        const vector = new THREE.Vector3(...bits.map((high, i) => high ? to[i] : from[i]));
        if (transform) vector.applyMatrix4(transform);
        return vector.sub(center).applyQuaternion(rotation).add(center).multiplyScalar(1 / 16);
      });
      const normal = vertices[1].clone().sub(vertices[0]).cross(vertices[2].clone().sub(vertices[0])).normalize();
      if (normal.lengthSq() === 0) continue;
      const shade = 0.48 + 0.51 * Math.max(0, normal.y) + 0.25 * Math.max(0, normal.z) + 0.13 * Math.abs(normal.x) + 0.08 * Math.max(0, -normal.z);
      const emission = Number.isFinite(element.light_emission) ? Math.min(element.light_emission, 15) / 15 : 0;
      const light = flatLight || element.shade === false ? 1 : Math.max(shade, emission);
      const tinted = material !== missingMaterial && Number.isInteger(face.tintindex) && face.tintindex >= 0;
      const faceTint = tinted ? (Array.isArray(tint) ? tint[face.tintindex] ?? white : tint) : white;
      const color = faceTint.clone().multiplyScalar(light);
      const uvs = faceUvs(face, direction, from, to, uvTransforms[direction]);
      vertices.forEach((vertex, index) => {
        let [u, v] = uvs[index];
        u /= 16;
        v /= 16;
        if (patch) {
          const { sheet, tile } = patch;
          // Sample within the selected tile while preserving cropped and rotated UVs.
          u = (tile % sheet.size + u) / sheet.size + (0.5 - u) / sheet.width;
          v = (Math.floor(tile / sheet.size) + v) / sheet.size + (0.5 - v) / sheet.height;
        }
        batch.position.push(vertex.x, vertex.y, vertex.z);
        batch.uv.push(u, 1 - v);
        batch.color.push(color.r, color.g, color.b);
      });
      batch.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }
  return finishBatches(batches);
}

export function materialKey({ texture, forceTranslucent, doubleSided }) {
  if (doubleSided) return `${texture}|${Boolean(forceTranslucent)}|double-sided`;
  return forceTranslucent ? `${texture}|translucent` : texture;
}

export function applyTexture(entry, { image, translucent, missing }) {
  const { material, texture, forceTranslucent, doubleSided } = entry;
  texture.image = image;
  texture.needsUpdate = true;
  material.map = texture;
  material.color.set('#ffffff');
  material.transparent = !missing && (forceTranslucent || translucent);
  material.alphaTest = material.transparent ? 0.04 : 0.5;
  material.depthWrite = !material.transparent;
  material.side = doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  material.forceSinglePass = Boolean(doubleSided);
  material.needsUpdate = true;
}
