import { BufferTarget, CanvasSource, Output, QUALITY_HIGH, WebMOutputFormat, getFirstEncodableVideoCodec } from 'mediabunny';

export async function encodeReplayVideo(canvas, { frameCount, frameDuration, drawFrame, onFrame, signal }) {
  const { width, height } = canvas;
  const frameRate = 1 / frameDuration;
  const quality = QUALITY_HIGH;
  const codec = await getFirstEncodableVideoCodec(['vp8', 'vp9'], { width, height, frameRate, quality });
  signal.throwIfAborted();
  if (!codec) throw new Error('当前 WebView 不支持 WebM 视频编码。');

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec, quality });
  output.addVideoTrack(source, { frameRate });
  const cancel = () => { void output.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    await output.start();
    for (let index = 0; index < frameCount; index++) {
      signal.throwIfAborted();
      await drawFrame(index);
      await source.add(index * frameDuration, frameDuration);
      onFrame(index);
      if ((index + 1) % 8 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    await output.finalize();
    signal.throwIfAborted();
    return output.target.buffer;
  } finally {
    signal.removeEventListener('abort', cancel);
    if (output.state !== 'finalized') await output.cancel();
  }
}
