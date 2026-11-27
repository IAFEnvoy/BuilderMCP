const fullHeight = 8 / 9;
const waterPlants = new Set([
  'minecraft:kelp', 'minecraft:kelp_plant', 'minecraft:seagrass', 'minecraft:tall_seagrass',
]);
const waterSource = { type: 'minecraft:water', height: fullHeight };
const bubbleColumn = { ...waterSource, standalone: true };
const sides = [
  { direction: 'north', dx: 0, dz: -1, opposite: 'south', corners: [0, 3] },
  { direction: 'south', dx: 0, dz: 1, opposite: 'north', corners: [1, 2] },
  { direction: 'west', dx: -1, dz: 0, opposite: 'east', corners: [0, 1] },
  { direction: 'east', dx: 1, dz: 0, opposite: 'west', corners: [2, 3] },
];

export const fluidProperties = { level: Array.from({ length: 16 }, (_, level) => String(level)) };

export function vanillaLiquidType(name) {
  if (name === 'minecraft:water' || name === 'minecraft:flowing_water') return 'minecraft:water';
  if (name === 'minecraft:lava' || name === 'minecraft:flowing_lava') return 'minecraft:lava';
  return null;
}

export function fluidState({ name, properties }, type) {
  if (type) {
    const level = Number(properties?.level ?? properties?.liquid_depth ?? 0);
    const horizontalLevel = Number.isInteger(level) && level > 0 && level < 8 ? level : 0;
    return { type, height: (8 - horizontalLevel) / 9, standalone: true };
  }
  if (name === 'minecraft:bubble_column') return bubbleColumn;
  if (properties?.waterlogged === 'true' || waterPlants.has(name)) return waterSource;
  return null;
}

function cornerHeight(center, a, b, diagonal) {
  if (a === 1 || b === 1) return 1;
  const heights = [center, a, b];
  if (a > 0 || b > 0) heights.push(diagonal());
  let total = 0;
  let weight = 0;
  for (const height of heights) {
    if (height === 1) return 1;
    if (height < 0) continue;
    const samples = height >= 0.8 ? 10 : 1;
    total += height * samples;
    weight += samples;
  }
  return total / weight;
}

export function fluidPart(fluid, sprites, [x, y, z], blockAt, fluidOf, occlusionAt, self) {
  const { type, height: ownHeight } = fluid;
  const above = blockAt?.(x, y + 1, z);
  const below = blockAt?.(x, y - 1, z);
  const covered = fluidOf(above?.state)?.type === type;
  const neighbors = sides.map(side => {
    const block = blockAt?.(x + side.dx, y, z + side.dz);
    const neighbor = fluidOf(block?.state);
    return { ...side, fluid: neighbor, shape: neighbor?.type === type ? null : occlusionAt(block) };
  });
  const bottom = fluidOf(below?.state)?.type !== type && self?.faces.down !== 1 && occlusionAt(below)?.faces.up !== 1;
  const top = !covered && self?.faces.up !== 1;
  if (!top && !bottom && neighbors.every(({ fluid }) => fluid?.type === type)) return null;

  const withFluidAbove = (dx, dz, height) => fluidOf(blockAt?.(x + dx, y + 1, z + dz)?.state)?.type === type ? 1 : height;
  const sample = (dx, dz, neighbor, shape) => neighbor?.type === type ? withFluidAbove(dx, dz, neighbor.height) : shape?.solid ? -1 : 0;
  const diagonal = (dx, dz) => {
    const block = blockAt?.(x + dx, y, z + dz);
    const neighbor = fluidOf(block?.state);
    return sample(dx, dz, neighbor, neighbor?.type === type ? null : occlusionAt(block));
  };
  let heights = [1, 1, 1, 1];
  if (!covered) {
    const [north, south, west, east] = neighbors.map(({ dx, dz, fluid, shape }) => sample(dx, dz, fluid, shape));
    // Match the four corners in northwest, southwest, southeast, northeast order.
    heights = [
      cornerHeight(ownHeight, north, west, () => diagonal(-1, -1)),
      cornerHeight(ownHeight, south, west, () => diagonal(-1, 1)),
      cornerHeight(ownHeight, south, east, () => diagonal(1, 1)),
      cornerHeight(ownHeight, north, east, () => diagonal(1, -1)),
    ];
  }

  const faces = [];
  let angle = null;
  // An opaque block above can only hide a surface that reaches the top of the cell.
  if (top && !(heights.every(height => height === 1) && occlusionAt(above)?.faces.down === 1)) {
    let flowX = 0;
    let flowZ = 0;
    for (const { dx, dz, fluid: neighbor, shape } of neighbors) {
      if (neighbor && neighbor.type !== type) continue;
      let slope = 0;
      if (neighbor) slope = ownHeight - neighbor.height;
      else if (!shape?.solid) {
        const lower = fluidOf(blockAt?.(x + dx, y - 1, z + dz)?.state);
        if (lower?.type === type) slope = ownHeight + fullHeight - lower.height;
      }
      flowX += slope * dx;
      flowZ += slope * dz;
    }
    if (Math.abs(flowX) + Math.abs(flowZ) > 1e-6) angle = Math.atan2(flowZ, flowX) - Math.PI / 2;
    faces.push({ direction: 'up', texture: angle === null ? sprites.still : sprites.flow, doubleSided: true });
  }
  if (bottom) faces.push({ direction: 'down', texture: sprites.still });
  for (const { direction, opposite, corners: [a, b], fluid: neighbor, shape } of neighbors) {
    if (neighbor?.type === type || self?.faces[direction] === 1 || (shape?.faces[opposite] ?? 0) >= Math.max(heights[a], heights[b])) continue;
    const overlay = sprites.overlay && shape?.overlay;
    faces.push({ direction, texture: overlay ? sprites.overlay : sprites.flow, doubleSided: !overlay });
  }
  if (!faces.length) return null;

  const key = JSON.stringify([type, heights, angle, faces.map(face => [face.direction, face.texture, face.doubleSided])]);
  return { key: `fluid:${key}`, fluid: { type, heights, angle, faces, sprites } };
}
