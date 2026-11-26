import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open, save } from '@tauri-apps/plugin-dialog';
import { JAVA_STRUCTURE_FORMATS } from './scene.js';

export const desktop = isTauri();
export const PACK_ARCHIVE_FORMATS = ['zip', 'jar'];
export const STRUCTURE_FORMATS = desktop ? [...JAVA_STRUCTURE_FORMATS, 'mcstructure'] : JAVA_STRUCTURE_FORMATS;

const types = {
  nbt: 'Minecraft Java 原版结构',
  litematic: 'Litematica 投影',
  mcstructure: 'Minecraft 基岩版结构',
  png: 'PNG 图片',
};

export function safeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'build';
}

export function fileInfo(path) {
  const filename = path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return { filename, name: filename, extension: '' };
  return { filename, name: filename.slice(0, dot), extension: filename.slice(dot + 1).toLowerCase() };
}

export function structureFileInfo(path) {
  if (typeof path !== 'string') throw new Error('请提供结构文件路径。');
  const { name, extension } = fileInfo(path);
  if (!STRUCTURE_FORMATS.includes(extension)) {
    throw new Error(`请选择 ${STRUCTURE_FORMATS.map(format => '.' + format).join('、')} 文件。`);
  }
  return { name, format: extension };
}

export async function readBrowserStructureFile(file) {
  const { name, format } = structureFileInfo(file.name);
  const { decodeStructure } = await import('./structure.js');
  const project = await decodeStructure(new Uint8Array(await file.arrayBuffer()), format, name);
  return { path: null, format, project };
}

export async function openProject() {
  if (desktop) {
    const path = await open({ filters: [{ name: 'Minecraft 结构文件', extensions: STRUCTURE_FORMATS }] });
    return path ? readStructureFile(path) : null;
  }
  const file = await new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = STRUCTURE_FORMATS.map(extension => '.' + extension).join(',');
    input.addEventListener('change', () => resolve(input.files[0]));
    input.addEventListener('cancel', () => resolve(null));
    input.click();
  });
  return file ? readBrowserStructureFile(file) : null;
}

function chooseSavePath(name, extension) {
  return save({ defaultPath: `${name}.${extension}`, filters: [{ name: types[extension], extensions: [extension] }] });
}

function downloadFile(bytes, name, extension) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return link.download;
}

export async function saveFile(bytes, name, extension) {
  if (!desktop) return downloadFile(bytes, name, extension);
  const path = await chooseSavePath(name, extension);
  if (!path) return null;
  await invoke('save_document', { path, data: encodeBase64(bytes) });
  return path;
}

export function readStructureFile(path) {
  structureFileInfo(path);
  return invoke('read_structure_file', { path });
}

export function saveStructureFile(project, path, format, overwrite, { preserveOrigin = true } = {}) {
  return invoke('save_structure_file', { path, format, overwrite, preserveOrigin, project });
}

export function saveReplayFile(buffer, path, overwrite) {
  return invoke('save_replay_file', { path, overwrite, data: encodeBase64(new Uint8Array(buffer)) });
}

export async function saveStructureAs(project, name, format) {
  if (desktop) {
    const path = await chooseSavePath(name, format);
    if (!path) return null;
    if (structureFileInfo(path).format !== format) throw new Error('文件扩展名需要与保存格式一致。');
    return saveStructureFile(project, path, format, true);
  }
  const { encodeStructure } = await import('./structure.js');
  const bytes = encodeStructure(project, format, { preserveOrigin: true, softwareVersion: __BUILDER_MCP_VERSION__ });
  const path = downloadFile(bytes, name, format);
  return { path, format, bytes: bytes.length };
}

export const packsOnDisk = {
  list: () => invoke('list_resource_packs'),
  setOrder: ids => invoke('set_resource_pack_order', { ids }),
  read: async id => new Uint8Array(await invoke('read_resource_pack', { id })),
  remove: id => invoke('remove_resource_pack', { id }),
  async choose(kind) {
    if (kind === 'folder' || kind === 'archive-folder') {
      const folder = await open({ directory: true });
      if (!folder) return [];
      if (kind === 'folder') return [folder];
      const archives = await invoke('list_resource_pack_archives', { path: folder });
      if (!archives.length) throw new Error('所选文件夹中没有 ZIP 或 JAR 文件。');
      return archives;
    }
    return await open({
      multiple: true,
      filters: [{ name: '资源包 ZIP / Minecraft JAR', extensions: PACK_ARCHIVE_FORMATS }],
    }) ?? [];
  },
  import: path => invoke('import_resource_pack', { path }),
};

export const minecraftTranslations = (version, locale) => invoke('minecraft_translations', { version, locale });

export async function connectMcp(dispatch) {
  let queue = Promise.resolve();
  await listen('builder-mcp-request', event => {
    const { id, name, arguments: args } = event.payload;
    queue = queue.then(async () => {
      let reply;
      try { reply = { value: await dispatch(name, args) }; }
      catch (error) { reply = { error: error instanceof Error ? error.message : String(error) }; }
      await invoke('mcp_reply', { id, ...reply });
    }).catch(error => console.error('MCP reply failed', error));
  });
  return invoke('mcp_ready');
}

export function encodeBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const parts = [];
  for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  return btoa(parts.join(''));
}

export function decodeBase64(data) {
  return Uint8Array.fromBase64 ? Uint8Array.fromBase64(data) : Uint8Array.from(atob(data), ch => ch.charCodeAt(0));
}
