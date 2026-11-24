export const TAG = {
  end: 0, byte: 1, short: 2, int: 3, long: 4, float: 5, double: 6,
  bytes: 7, string: 8, list: 9, compound: 10, ints: 11, longs: 12,
};

const minimumTagSize = [0, 1, 2, 4, 8, 4, 8, 4, 2, 5, 1, 4, 4];
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_TAGS = 4_000_000;
const MAX_DEPTH = 512;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function nbtString(bytes) {
  try { return utf8.decode(bytes); }
  catch { /* Java encodes NUL and UTF-16 surrogates with modified UTF-8. */ }

  let result = '';
  for (let i = 0; i < bytes.length; i++) {
    const first = bytes[i];
    let code = first;
    if (first >= 0x80) {
      const extra = first >= 0xe0 && first < 0xf0 ? 2 : first >= 0xc0 && first < 0xe0 ? 1 : 0;
      if (!extra || i + extra >= bytes.length) throw new Error('NBT 字符串编码无效。');
      code = first & (extra === 2 ? 0x0f : 0x1f);
      for (let j = 0; j < extra; j++) {
        const next = bytes[++i];
        if ((next & 0xc0) !== 0x80) throw new Error('NBT 字符串编码无效。');
        code = (code << 6) | (next & 0x3f);
      }
    }
    result += String.fromCharCode(code);
  }
  return result;
}

class NbtReader {
  offset = 0;
  tagsLeft = MAX_TAGS;

  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  take(size) {
    const start = this.offset;
    this.offset += size;
    if (this.offset > this.bytes.length) throw new Error('NBT 文件不完整。');
    return start;
  }

  byte() { return this.view.getUint8(this.take(1)); }
  int() { return this.view.getInt32(this.take(4)); }

  length() {
    const length = this.int();
    if (length < 0) throw new Error('NBT 数组或列表长度无效。');
    return length;
  }

  data(size) {
    const start = this.take(size);
    return this.bytes.subarray(start, start + size);
  }

  string() {
    return nbtString(this.data(this.view.getUint16(this.take(2))));
  }

  list(depth) {
    const type = this.byte();
    const length = this.length();
    if (!length) return [];
    const minimum = minimumTagSize[type];
    if (!minimum || length * minimum > this.bytes.length - this.offset || length > this.tagsLeft) {
      throw new Error('NBT 列表长度或类型无效。');
    }
    const items = [];
    for (let i = 0; i < length; i++) items.push(this.value(type, depth + 1));
    return items;
  }

  compound(depth) {
    const fields = Object.create(null);
    for (let type = this.byte(); type !== TAG.end; type = this.byte()) {
      const name = this.string();
      fields[name] = this.value(type, depth + 1);
    }
    return fields;
  }

  value(type, depth) {
    if (depth > MAX_DEPTH || --this.tagsLeft < 0) throw new Error('NBT 标签数量或嵌套深度超过上限。');
    switch (type) {
      case TAG.byte: return this.view.getInt8(this.take(1));
      case TAG.short: return this.view.getInt16(this.take(2));
      case TAG.int: return this.int();
      case TAG.long: return this.view.getBigInt64(this.take(8));
      case TAG.float: return this.view.getFloat32(this.take(4));
      case TAG.double: return this.view.getFloat64(this.take(8));
      case TAG.bytes: return this.data(this.length());
      case TAG.string: return this.string();
      case TAG.list: return this.list(depth);
      case TAG.compound: return this.compound(depth);
      case TAG.ints: return this.data(this.length() * 4);
      case TAG.longs: {
        const size = this.length() * 8;
        return new DataView(this.view.buffer, this.view.byteOffset + this.take(size), size);
      }
      default: throw new Error('NBT 标签类型无效。');
    }
  }

  root() {
    if (this.byte() !== TAG.compound) throw new Error('文件不是 Java 版 NBT 结构。');
    this.string();
    const value = this.compound(0);
    if (this.offset !== this.bytes.length) throw new Error('NBT 根标签后包含多余的数据。');
    return value;
  }
}

async function expandNbt(bytes) {
  if (bytes.length > MAX_BYTES) throw new Error('结构文件超过 128 MiB。');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const chunks = [];
  let size = 0;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BYTES) {
        await reader.cancel();
        throw new Error('结构文件解压后超过 128 MiB。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof TypeError) throw new Error('结构文件的 GZIP 数据损坏。', { cause: error });
    throw error;
  } finally {
    reader.releaseLock();
  }
  const expanded = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    expanded.set(chunk, offset);
    offset += chunk.length;
  }
  return expanded;
}

export async function readNbt(bytes) {
  return new NbtReader(await expandNbt(bytes)).root();
}
