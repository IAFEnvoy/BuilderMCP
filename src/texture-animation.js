export const TEXTURE_TICK_MS = 50;

function positiveInt(value) {
  return Number.isInteger(value) && value >= 1 && value <= 2_147_483_647;
}

export function textureTimeline(metadata, imageWidth, imageHeight) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const square = Math.min(imageWidth, imageHeight);
  const width = metadata.width ?? (metadata.height == null ? square : imageWidth);
  const height = metadata.height ?? (metadata.width == null ? square : imageHeight);
  if (!positiveInt(width) || !positiveInt(height) || imageWidth % width || imageHeight % height) {
    throw new Error('纹理帧尺寸无效。');
  }

  const frameTime = metadata.frametime ?? 1;
  if (!positiveInt(frameTime)) throw new Error('纹理帧时长无效。');
  if (metadata.frames !== undefined && !Array.isArray(metadata.frames)) throw new Error('纹理帧列表无效。');

  const columns = imageWidth / width;
  const frameCount = columns * (imageHeight / height);
  const frames = metadata.frames?.length ? [] : null;
  let duration = frames ? 0 : frameCount * frameTime;
  if (frames) {
    for (const frame of metadata.frames) {
      const index = frame?.index ?? frame;
      const time = frame?.time ?? frameTime;
      if (!Number.isInteger(index) || index < 0 || index >= frameCount || !positiveInt(time)) continue;
      duration += time;
      frames.push({ index, time, end: duration });
    }
  }

  const firstFrame = frames?.[0]?.index ?? 0;
  const animated = frames ? frames.some(({ index }) => index !== firstFrame) : frameCount > 1;
  const interpolate = metadata.interpolate === true;
  return { width, height, columns, frameCount, frameTime, frames, duration, firstFrame, animated, interpolate };
}

export function textureFrameAt(timeline, tick) {
  const { animated, firstFrame, duration, frames, frameCount, frameTime, interpolate } = timeline;
  if (!animated) return { index: firstFrame, next: firstFrame, mix: 0 };
  const elapsed = tick % duration;
  if (!frames) {
    const index = Math.floor(elapsed / frameTime);
    return { index, next: (index + 1) % frameCount, mix: interpolate ? (elapsed % frameTime) / frameTime : 0 };
  }

  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (elapsed < frames[middle].end) high = middle;
    else low = middle + 1;
  }
  const { index, time, end } = frames[low];
  const start = end - time;
  const next = frames[(low + 1) % frames.length].index;
  return { index, next, mix: interpolate && index !== next ? (elapsed - start) / time : 0 };
}

function canvasContext(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.getContext('2d', { willReadFrequently: true });
}

function frameOffset(sheet, timeline, index) {
  const x = (index % timeline.columns) * timeline.width;
  const y = Math.floor(index / timeline.columns) * timeline.height;
  return (y * sheet.width + x) * 4;
}

function partialAlpha({ data }) {
  for (let a = 3; a < data.length; a += 4) if (data[a] > 0 && data[a] < 255) return true;
  return false;
}

function animatedTranslucency(sheet, timeline) {
  const { frames, frameCount, frameTime, width, height, interpolate } = timeline;
  if (!frames && (!interpolate || frameTime === 1)) return partialAlpha(sheet);
  const { data } = sheet;
  const stride = sheet.width * 4;
  const isTranslucent = (index, next) => {
    const start = frameOffset(sheet, timeline, index);
    const end = frameOffset(sheet, timeline, next);
    for (let y = 0; y < height; y++) {
      const row = y * stride;
      for (let x = 3; x < width * 4; x += 4) {
        const alpha = data[start + row + x];
        if ((alpha > 0 && alpha < 255) || alpha !== data[end + row + x]) return true;
      }
    }
    return false;
  };
  if (!frames) {
    for (let index = 0; index < frameCount; index++) if (isTranslucent(index, (index + 1) % frameCount)) return true;
    return false;
  }

  const checked = new Set();
  for (const [position, { index, time }] of frames.entries()) {
    const next = interpolate && time > 1 ? frames[(position + 1) % frames.length].index : index;
    const pair = index * frameCount + next;
    if (checked.has(pair)) continue;
    if (isTranslucent(index, next)) return true;
    checked.add(pair);
  }
  return false;
}

export async function decodeTexture(bytes, metadata) {
  if (bytes.length < 24) throw new Error('纹理格式无效。');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(16);
  const height = header.getUint32(20);
  if (width > 8192 || height > 8192 || width * height > 33_554_432) throw new Error('纹理尺寸过大。');
  const timeline = textureTimeline(metadata, width, height);
  const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    const frameWidth = timeline?.width ?? width;
    const frameHeight = timeline?.height ?? height;
    const frame = timeline?.firstFrame ?? 0;
    const columns = timeline?.columns ?? 1;
    const context = canvasContext(frameWidth, frameHeight);
    context.drawImage(bitmap, (frame % columns) * frameWidth, Math.floor(frame / columns) * frameHeight,
      frameWidth, frameHeight, 0, 0, frameWidth, frameHeight);
    const image = context.canvas;
    if (!timeline?.animated) return { image, translucent: partialAlpha(context.getImageData(0, 0, frameWidth, frameHeight)) };

    const atlas = canvasContext(width, height);
    atlas.drawImage(bitmap, 0, 0);
    const sheet = atlas.getImageData(0, 0, width, height);
    atlas.canvas.width = 0;
    return { image, translucent: animatedTranslucency(sheet, timeline), animation: { ...timeline, sheet } };
  } finally { bitmap.close(); }
}

export function createTexturePlayer(timeline) {
  const { width, height, sheet } = timeline;
  const context = canvasContext(width, height);
  const output = context.createImageData(width, height);
  const stride = sheet.width * 4;
  const rowSize = width * 4;
  const { data } = sheet;
  const pixels = output.data;
  let lastTick;
  let previous;
  return {
    image: context.canvas,
    update(tick) {
      if (tick === lastTick) return false;
      lastTick = tick;
      const sample = textureFrameAt(timeline, tick);
      const { index, next, mix } = sample;
      if (previous?.index === index && previous.mix === mix && (!mix || previous.next === next)) return false;
      previous = sample;

      const start = frameOffset(sheet, timeline, index);
      const nextStart = mix ? frameOffset(sheet, timeline, next) : 0;
      for (let row = 0; row < height; row++) {
        const from = start + row * stride;
        const to = row * rowSize;
        if (!mix) {
          pixels.set(data.subarray(from, from + rowSize), to);
          continue;
        }
        const blend = nextStart + row * stride;
        for (let col = 0; col < rowSize; col++) {
          const value = data[from + col];
          pixels[to + col] = value + (data[blend + col] - value) * mix;
        }
      }
      context.putImageData(output, 0, 0);
      return true;
    },
  };
}
