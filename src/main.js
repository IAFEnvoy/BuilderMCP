import {
  Box, Boxes, BoxSelect, Camera, Check, ChevronDown, CircleAlert, CircleHelp, ClipboardPaste, Copy, Cuboid,
  Download, Eraser, FileBox, FilePlus, FolderArchive, FolderOpen, Grid3x3, GripVertical, ImageDown, Languages, Layers, Mouse, MousePointer2,
  Move3d, Package, PackagePlus, PaintBucket, Pipette, Plus, Redo2, Replace, RotateCcw, RotateCw,
  Save, Scan, ScanLine, Search, Settings2, SlidersHorizontal, SquareDashedMousePointer, Trash2, Undo2, X, createElement,
} from 'lucide';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Sortable from 'sortablejs';
import './styles.css';
import {
  connectMcp, decodeBase64, desktop, fileInfo, minecraftTranslations, openProject, PACK_ARCHIVE_FORMATS,
  packsOnDisk, readBrowserStructureFile, readStructureFile, safeFilename, saveFile, saveStructureAs, saveStructureFile, structureFileInfo, STRUCTURE_FORMATS,
} from './desktop.js';
import { editorMcp } from './editor-mcp.js';
import { DEFAULT_LOCALE, ENGLISH_LOCALE, LOCALE_KEY, localeName, normalizeLocale } from './locales.js';
import { dataVersionFor, minecraftVersionFor, MINECRAFT_RELEASES } from './minecraft-versions.js';
import { ModelPreview } from './model-preview.js';
import { BlockCatalog, loadArchive } from './resource-pack.js';
import { BuildScene, boundsOf, cellKey, emptyProject, MAX_COORDINATE, samePoint } from './scene.js';
import { DEFAULT_CAMERA_PRESET, drawCompass, Viewport } from './viewport.js';

const byId = id => document.getElementById(id);
const modIdFilter = byId('block-mod-id');
const unsavedDialog = byId('unsaved-dialog');
const packList = byId('pack-list');
const packImportButtons = document.querySelectorAll('[data-pack-type]');
const packProgressPanels = document.querySelectorAll('[data-pack-progress]');
const toolButtons = document.querySelectorAll('[data-tool]');
const projectionButtons = document.querySelectorAll('[data-projection]');
const presetButtons = document.querySelectorAll('[data-preset]');
const brushTools = new Set(['place', 'replace', 'fill']);
const PALETTE_PAGE_SIZE = 120;
const modelPreview = new ModelPreview();
const icons = {
  box: Box, boxes: Boxes, 'box-select': BoxSelect, camera: Camera, check: Check, 'chevron-down': ChevronDown,
  'circle-alert': CircleAlert, 'circle-help': CircleHelp, 'clipboard-paste': ClipboardPaste, copy: Copy, cuboid: Cuboid, download: Download,
  eraser: Eraser, 'file-box': FileBox, 'file-plus': FilePlus, 'folder-archive': FolderArchive, 'folder-open': FolderOpen,
  'grid-3x3': Grid3x3, 'grip-vertical': GripVertical, 'image-down': ImageDown,
  languages: Languages, layers: Layers, mouse: Mouse, 'mouse-pointer-2': MousePointer2, 'move-3d': Move3d, package: Package,
  'package-plus': PackagePlus, 'paint-bucket': PaintBucket, pipette: Pipette, plus: Plus, 'redo-2': Redo2, replace: Replace,
  'rotate-ccw': RotateCcw, 'rotate-cw': RotateCw, save: Save, scan: Scan, 'scan-line': ScanLine, search: Search,
  'settings-2': Settings2, 'sliders-horizontal': SlidersHorizontal, 'square-dashed-mouse-pointer': SquareDashedMousePointer,
  'trash-2': Trash2, 'undo-2': Undo2, x: X,
};

function icon(name) {
  return createElement(icons[name], { 'aria-hidden': 'true' });
}

for (const element of document.querySelectorAll('[data-icon]')) {
  const svg = icon(element.dataset.icon);
  svg.setAttribute('class', element.className);
  element.replaceWith(svg);
}

for (const element of document.querySelectorAll('[data-desktop-format]')) {
  element.hidden = !desktop;
  element.disabled = !desktop;
}

const build = new BuildScene(emptyProject());
let locale = normalizeLocale(localStorage.getItem(LOCALE_KEY)) ?? DEFAULT_LOCALE;
let catalog = new BlockCatalog([], locale);
let officialVersion = null;
let officialLocales = [];
let officialLanguages = new Map();
const languageRequests = new Set();
let brush = null;
let tool = 'select';
let category = 'all';
let firstCorner = null;
let currentPreset = DEFAULT_CAMERA_PRESET;
let currentFile = null;
let savedRevision = build.revision;
let paletteLimit = PALETTE_PAGE_SIZE;
let packs = new Map();
let packBusy = false;
let packQueue = Promise.resolve();
let projectBusy = false;
let mcp = { url: '', error: desktop ? '' : '请使用桌面应用启动 MCP 服务。' };
let viewport;
let toastTimer;

const tools = {
  select: '点击选取，Shift + 点击多选',
  place: '点击放置方块',
  replace: '点击已有方块替换，点击选区内的方块可替换整个选区',
  erase: '点击擦除方块',
  box: '点击区域选区的第一个角点',
  fill: '点击填充区域的第一个角点',
  pick: '点击吸取方块及其状态',
  paste: '左键确认粘贴，Esc 取消',
};

function status(message) {
  byId('status-message').textContent = message;
}

function toast(message, error = false) {
  const element = byId('toast');
  clearTimeout(toastTimer);
  element.classList.toggle('error', error);
  element.replaceChildren(icon(error ? 'circle-alert' : 'check'), document.createTextNode(message));
  element.hidden = false;
  toastTimer = setTimeout(() => { element.hidden = true; }, error ? 6500 : 2900);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function handleError(error) {
  toast(errorMessage(error), true);
}

function onClick(id, action) {
  byId(id).addEventListener('click', async event => {
    try { await action(event); }
    catch (error) { handleError(error); }
  });
}

function isProjectDirty() {
  return build.revision !== savedRevision;
}

function requireSavedProject(discardUnsaved = false) {
  if (typeof discardUnsaved !== 'boolean') throw new Error('discard_unsaved must be a boolean.');
  if (!discardUnsaved && isProjectDirty()) {
    throw new Error('Save the current project or set discard_unsaved to true to replace it.');
  }
}

function toggleTool(next) {
  if (!brush && brushTools.has(next)) {
    status('请先在方块库选择方块');
    return;
  }
  tool = next;
  firstCorner = null;
  for (const button of toolButtons) button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
  status(tools[tool]);
  viewport?.setHover(null);
  viewport?.invalidate();
}

function chooseBrush(state, switchTool = false) {
  brush = state ? catalog.state(state) : null;
  if (!brush && brushTools.has(tool)) toggleTool('select');
  if (brush && switchTool && !brushTools.has(tool)) toggleTool('place');
  renderBrush();
  for (const button of byId('palette').querySelectorAll('[data-block]')) button.setAttribute('aria-pressed', String(button.dataset.block === brush?.name));
}

function resetPalette() {
  paletteLimit = PALETTE_PAGE_SIZE;
  renderPalette();
}

function renderPalette(resetScroll = true) {
  const root = byId('palette');
  const matches = catalog.find(byId('palette-search').value, category, modIdFilter.value);
  byId('palette-count').textContent = matches.length.toLocaleString();
  if (resetScroll) byId('palette-scroll').scrollTop = 0;
  root.replaceChildren();
  if (!matches.length) {
    const empty = document.createElement('p');
    empty.className = 'palette-message';
    empty.textContent = catalog.blocks.size ? '没有匹配的方块' : '导入资源包以加载方块';
    root.append(empty);
    return;
  }

  const tiles = document.createDocumentFragment();
  const source = catalog;
  for (const block of matches.slice(0, paletteLimit)) {
    const tile = document.createElement('button');
    tile.className = 'tile';
    tile.dataset.block = block.name;
    tile.title = `${block.label}\n${block.name}`;
    tile.setAttribute('aria-pressed', String(block.name === brush?.name));
    const thumbnail = document.createElement('canvas');
    thumbnail.width = thumbnail.height = 64;
    const label = document.createElement('span');
    label.textContent = block.label;
    tile.append(thumbnail, label);
    tiles.append(tile);
    modelPreview.draw(source, block.state, thumbnail, true).catch(() => {});
  }
  if (paletteLimit < matches.length) {
    const more = document.createElement('button');
    more.className = 'button subtle palette-more';
    more.textContent = '显示更多';
    more.addEventListener('click', () => { paletteLimit += PALETTE_PAGE_SIZE; renderPalette(false); });
    tiles.append(more);
  }
  root.append(tiles);
}

function renderBrush() {
  byId('brush-empty').hidden = Boolean(brush);
  byId('brush-card').hidden = !brush;
  updateBrushName();
  byId('brush-id').textContent = brush?.name ?? '';
  byId('brush-id').title = brush?.name ?? '';
  renderBrushThumbnail();
  for (const button of toolButtons) {
    if (brushTools.has(button.dataset.tool)) button.disabled = !brush;
  }
  const root = byId('brush-properties');
  root.hidden = !brush;
  root.replaceChildren();
  if (!brush) return;

  const block = catalog.blocks.get(brush.name);
  const keys = new Set([...Object.keys(block?.properties ?? {}), ...Object.keys(brush.properties ?? {})]);
  for (const key of keys) {
    const values = new Set(block?.properties[key] ?? []);
    const current = brush.properties?.[key];
    if (current !== undefined) values.add(current);
    const label = document.createElement('label');
    label.className = 'property';
    const name = document.createElement('span');
    name.textContent = key;
    name.title = key;
    const select = document.createElement('select');
    for (const value of values) select.add(new Option(value, value));
    select.value = current ?? select.options[0]?.value;
    select.addEventListener('change', () => {
      brush = catalog.state({ name: brush.name, properties: { ...brush.properties, [key]: select.value } });
      renderBrushThumbnail();
    });
    label.append(name, select);
    root.append(label);
  }
  if (!keys.size) {
    const message = document.createElement('span');
    message.className = 'property-empty';
    message.textContent = '无可调方块状态';
    root.append(message);
  }
}

function updateBrushName() {
  byId('brush-name').textContent = brush ? catalog.label(brush.name) : '';
}

function renderBrushThumbnail() {
  const thumbnail = document.createElement('canvas');
  thumbnail.id = 'brush-icon';
  thumbnail.width = thumbnail.height = 64;
  byId('brush-icon').replaceWith(thumbnail);
  if (brush) modelPreview.draw(catalog, brush, thumbnail).catch(() => {});
}

function axisInputs(id, min) {
  return ['X', 'Y', 'Z'].map(axis => {
    const label = document.createElement('label');
    const marker = document.createElement('span');
    marker.textContent = axis;
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.min = String(min);
    input.max = String(MAX_COORDINATE);
    input.required = true;
    input.setAttribute('aria-label', `${id === 'transform-origin' ? '原点' : '尺寸'} ${axis}`);
    label.append(marker, input);
    byId(id).append(label);
    return input;
  });
}

const originFields = axisInputs('transform-origin', -MAX_COORDINATE);
const sizeFields = axisInputs('transform-size', 1);
let selectionBounds;

function updateScene(change = {}) {
  if (!change.selection) {
    byId('project-name').textContent = build.name;
    byId('project-name').title = build.name;
    byId('project-dirty').hidden = !isProjectDirty();
    byId('undo').disabled = !build.history.length;
    byId('redo').disabled = !build.future.length;
    byId('scene-count').textContent = build.blocks.size.toLocaleString();
    byId('scene-bounds').textContent = build.bounds?.size.join(' × ') ?? '—';
    byId('minecraft-version').textContent = minecraftVersionFor(build.dataVersion) ?? '未知版本';
    byId('edition').textContent = currentFile?.format === 'mcstructure' ? 'Minecraft Bedrock' : 'Minecraft Java';
    byId('select-all').disabled = !build.blocks.size;
    byId('export-image').disabled = !viewport || !build.blocks.size;
  }
  byId('selection-count').textContent = build.selection.size.toLocaleString();
  byId('copy-selection').disabled = !build.selection.size;
  byId('selection-empty').hidden = Boolean(build.selection.size);
  byId('transform').hidden = !build.selection.size;
  const bounds = boundsOf(build.selected);
  if (bounds && (!selectionBounds || !samePoint(bounds.min, selectionBounds.min) || !samePoint(bounds.size, selectionBounds.size))) {
    originFields.forEach((input, index) => { input.value = bounds.min[index]; });
    sizeFields.forEach((input, index) => { input.value = bounds.size[index]; });
  }
  selectionBounds = bounds;
}

function updateCameraButtons() {
  const projection = viewport?.projection;
  for (const button of projectionButtons) button.setAttribute('aria-pressed', String(button.dataset.projection === projection));
  for (const button of presetButtons) {
    const active = button.dataset.preset === currentPreset && (currentPreset !== 'isometric' || projection === 'orthographic');
    button.setAttribute('aria-pressed', String(active));
  }
}

function frame(preset, projection) {
  if (preset === undefined) {
    preset = currentPreset ?? DEFAULT_CAMERA_PRESET;
    projection = viewport?.projection;
  }
  viewport?.frame(preset, projection);
  currentPreset = preset;
  updateCameraButtons();
}

function setProjection(projection) {
  viewport?.setProjection(projection);
  updateCameraButtons();
}

async function saveViewportImage(transparent) {
  if (!viewport) throw new Error('三维视图不可用。');
  const filename = `${safeFilename(build.name)}-${transparent ? '透明渲染' : '视图'}`;
  const { data } = await viewport.capture(transparent ? 1920 : undefined, { transparent });
  if (await saveFile(decodeBase64(data), filename, 'png')) toast(transparent ? '已导出透明 PNG' : '已保存截图');
}

function hover(hit) {
  const placing = tool === 'place' || tool === 'paste';
  const region = tool === 'box' || tool === 'fill';
  const pos = placing ? hit?.place : region ? hit?.cell ?? hit?.place : hit?.cell;
  byId('cursor-position').textContent = pos ? `X ${pos[0]}   Y ${pos[1]}   Z ${pos[2]}` : 'X —   Y —   Z —';
  if (tool === 'paste' && pos) {
    const size = build.clipboardSize;
    const end = pos.map((n, axis) => n + size[axis] - 1);
    const fits = [pos, end].every(corner => corner.every(n => Math.abs(n) <= MAX_COORDINATE));
    viewport.setHover(pos, end, fits ? '#a5e191' : '#ef938b');
    return;
  }
  viewport.setHover(firstCorner ?? pos, pos, tool === 'erase' ? '#ef938b' : '#ffd28b');
}

function copySelection() {
  const copied = build.copySelection();
  byId('paste-selection').disabled = !viewport;
  viewport?.invalidate();
  toast(`已复制 ${copied.count.toLocaleString()} 个方块`);
  return copied;
}

function clickScene(hit, event) {
  try {
    if (tool === 'select') {
      const keys = event.shiftKey ? new Set(build.selection) : new Set();
      if (hit?.cell) {
        const key = cellKey(hit.cell);
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
      }
      build.select(keys);
      status(keys.size ? `已选中 ${keys.size.toLocaleString()} 个方块` : tools[tool]);
      return;
    }
    if (!hit) return;
    if (tool === 'paste') {
      const changes = build.pasteSelection(hit.place);
      toggleTool('select');
      status(changes ? `粘贴更新了 ${changes.toLocaleString()} 个方块` : '目标位置已有相同方块');
      return;
    }
    if (tool === 'place') build.setBlocks([{ pos: hit.place, state: brush }]);
    if (tool === 'replace' && hit.cell) {
      const changes = build.selection.has(cellKey(hit.cell))
        ? build.paintSelection(brush)
        : build.setBlocks([{ pos: hit.cell, state: brush }]);
      status(changes ? `已替换 ${changes.toLocaleString()} 个方块` : '目标已是当前画笔状态');
    }
    if (tool === 'erase' && hit.cell) build.setBlocks([{ pos: hit.cell, state: null }]);
    if (tool === 'pick' && hit.cell) {
      chooseBrush(build.blocks.get(cellKey(hit.cell)).state, true);
      status(`已吸取 ${brush.name}`);
    }
    if (tool === 'box' || tool === 'fill') {
      const pos = hit.cell ?? hit.place;
      if (!firstCorner) {
        firstCorner = pos;
        status(`起点 (${pos.join(', ')})，点击区域的另一角`);
        return;
      }
      if (tool === 'box') {
        const count = build.selectBox(firstCorner, pos);
        status(`已选中 ${count.toLocaleString()} 个方块`);
      } else {
        const count = build.fillBox(firstCorner, pos, brush);
        status(`填充更新了 ${count.toLocaleString()} 个方块`);
      }
      firstCorner = null;
      viewport.invalidate();
    }
  } catch (error) { handleError(error); }
}

function applyHistory(action) {
  if (!build[action]()) return false;
  firstCorner = null;
  viewport?.setHover(null);
  status(action === 'undo' ? '已撤销' : '已重做');
  return true;
}

async function projectAction(action) {
  if (projectBusy) throw new Error('另一个项目文件操作正在进行。');
  projectBusy = true;
  try { return await action(); }
  finally { projectBusy = false; }
}

function chooseUnsavedAction(operation) {
  setSaveMenu(false);
  byId('unsaved-message').textContent = `在${operation}前保存「${build.name}」的修改？`;
  byId('unsaved-format-field').hidden = Boolean(currentFile?.format);
  byId('unsaved-format').value = 'litematic';
  unsavedDialog.returnValue = 'cancel';
  unsavedDialog.showModal();
  return new Promise(resolve => {
    unsavedDialog.addEventListener('close', () => resolve(unsavedDialog.returnValue), { once: true });
  });
}

function leaveProject(operation, proceed) {
  return projectAction(async () => {
    if (isProjectDirty()) {
      const choice = await chooseUnsavedAction(operation);
      if (choice === 'save') {
        const selectedFormat = currentFile?.format ? undefined : byId('unsaved-format').value;
        if (!await saveCurrentProject(selectedFormat)) return;
        if (isProjectDirty()) throw new Error('保存期间又有修改，请再保存一次。');
      } else if (choice !== 'discard') return;
    }
    return proceed(build.revision);
  });
}

async function guardWindowClose() {
  if (!desktop) {
    window.addEventListener('beforeunload', event => {
      if (!isProjectDirty()) return;
      event.preventDefault();
      event.returnValue = true;
    });
    return;
  }
  const appWindow = getCurrentWindow();
  await appWindow.onCloseRequested(async event => {
    event.preventDefault();
    if (projectBusy) return;
    try { await leaveProject('关闭窗口', () => appWindow.destroy()); }
    catch (error) { handleError(error); }
  });
}

function projectInfo() {
  return {
    name: build.name, minecraftVersion: minecraftVersionFor(build.dataVersion),
    dataVersion: build.dataVersion, blockCount: build.blocks.size,
    path: currentFile?.path ?? null, format: currentFile?.format ?? null,
    dirty: isProjectDirty(),
  };
}

function setProject(project, file = null) {
  build.load(project);
  if (tool === 'paste') toggleTool('select');
  currentFile = file;
  savedRevision = build.revision;
  firstCorner = null;
  setSaveMenu(false);
  frame(viewport?.projection === 'orthographic' ? 'isometric' : DEFAULT_CAMERA_PRESET);
  updateScene();
}

function newProject(name, dataVersion = build.dataVersion) {
  const project = emptyProject(dataVersion);
  if (name !== undefined) project.name = name;
  setProject(project);
  status('已新建项目');
  return projectInfo();
}

function showOpenedProject(project, { path, format }) {
  setProject(project, { path, format });
  status('已打开 .' + format + ' · ' + build.blocks.size.toLocaleString() + ' 个方块');
  return projectInfo();
}

function openEditorProject(read) {
  return leaveProject('打开文件', async revision => {
    const file = await read();
    if (!file) return;
    if (build.revision !== revision && isProjectDirty()) throw new Error('打开文件期间项目有新的修改，请重新打开文件。');
    return showOpenedProject(file.project, file);
  });
}

async function writeProject(write) {
  const revision = build.revision;
  const snapshot = build.snapshot();
  const saved = await write(snapshot);
  if (!saved) return null;
  const { path, format } = saved;
  currentFile = { path: desktop ? path : null, format };
  savedRevision = revision;
  updateScene();
  toast('已保存 .' + format);
  return { ...saved, blockCount: snapshot.blocks.length };
}

async function saveCurrentProject(asFormat) {
  const format = asFormat ?? currentFile?.format;
  if (!format) {
    setSaveMenu(true);
    return null;
  }
  setSaveMenu(false);
  const path = asFormat ? null : currentFile.path;
  return writeProject(project => path
    ? saveStructureFile(project, path, format, true)
    : saveStructureAs(project, safeFilename(project.name), format));
}

function saveProject(asFormat) {
  return projectAction(() => saveCurrentProject(asFormat));
}

function saveMcpProject({ path, format, overwrite }) {
  return projectAction(() => {
    const explicitFile = path === undefined ? null : structureFileInfo(path);
    if (format !== undefined && !STRUCTURE_FORMATS.includes(format)) throw new Error(`Choose a format from ${STRUCTURE_FORMATS.join(', ')}.`);
    if (overwrite !== undefined && typeof overwrite !== 'boolean') throw new Error('overwrite must be a boolean.');
    const selectedFormat = format ?? explicitFile?.format ?? currentFile?.format ?? 'litematic';
    if (explicitFile && explicitFile.format !== selectedFormat) {
      throw new Error('The file extension must match the selected structure format.');
    }
    const currentPath = currentFile?.format === selectedFormat ? currentFile.path : null;
    const target = path ?? currentPath;
    const replace = overwrite ?? (path === undefined && Boolean(target));
    return writeProject(project => saveStructureFile(project, target, selectedFormat, replace));
  });
}

function updateCatalog() {
  const active = [...packs.values()].filter(pack => pack.data).map(pack => pack.data);
  const version = [...packs.values()].findLast(pack => pack.kind === 'jar' && pack.data?.minecraftVersion)?.data.minecraftVersion ?? null;
  if (version !== officialVersion) {
    officialVersion = version;
    officialLocales = [];
    officialLanguages = new Map();
  }
  catalog = new BlockCatalog(active, locale, officialLanguages);
  modelPreview.setCatalog();
  chooseBrush(brush && catalog.blocks.has(brush.name) ? brush : null);
  viewport?.setCatalog(catalog);
  const selectedModId = modIdFilter.value;
  renderModIds();
  if (modIdFilter.value !== selectedModId) resetPalette();
  else renderPalette(false);
  renderLanguages();
  void loadOfficialLanguage();
}

function renderModIds() {
  const selected = modIdFilter.value;
  const ids = catalog.namespaces;
  modIdFilter.replaceChildren(new Option('全部模组', ''), ...ids.map(id => new Option(id, id)));
  modIdFilter.value = ids.includes(selected) ? selected : '';
  modIdFilter.disabled = !ids.length;
}

function renderLanguages() {
  const input = byId('block-language');
  const preferred = [DEFAULT_LOCALE, ENGLISH_LOCALE];
  const others = [...new Set([...officialLocales, ...catalog.languages.keys(), locale])]
    .filter(code => !preferred.includes(code))
    .map(code => new Option(localeName(code), code))
    .sort((a, b) => a.text.localeCompare(b.text));
  input.replaceChildren(...preferred.map(code => new Option(localeName(code), code)), ...others);
  input.value = locale;
  input.toggleAttribute('aria-busy', languageRequests.has(`${officialVersion}/${locale}`));
}

function updateNames() {
  catalog.setLocale(locale);
  updateBrushName();
  renderPalette(false);
  renderLanguages();
}

async function loadOfficialLanguage() {
  if (!desktop || !officialVersion) return;
  const version = officialVersion;
  const code = locale;
  if (officialLanguages.has(code)) return;
  const key = `${version}/${code}`;
  if (languageRequests.has(key)) return;
  const input = byId('block-language');
  languageRequests.add(key);
  input.setAttribute('aria-busy', 'true');
  try {
    const result = await minecraftTranslations(version, code);
    if (version !== officialVersion) return;
    if (result.locales.length) officialLocales = result.locales;
    if (!result.unavailable) officialLanguages.set(code, new Map(Object.entries(result.labels)));
    if (code === locale) updateNames();
    else renderLanguages();
  } catch (error) {
    console.warn('Minecraft translations unavailable', error);
  } finally {
    languageRequests.delete(key);
    input.toggleAttribute('aria-busy', languageRequests.has(`${officialVersion}/${locale}`));
  }
}

const packMotion = matchMedia('(prefers-reduced-motion: reduce)');
const packSorter = Sortable.create(packList, {
  draggable: '.pack-row',
  handle: '.pack-handle',
  dataIdAttr: 'data-pack-id',
  direction: 'vertical',
  // Use pointer dragging so Tauri's native file drop remains available.
  forceFallback: true,
  fallbackTolerance: 4,
  ghostClass: 'pack-placeholder',
  fallbackClass: 'pack-dragging',
  animation: packMotion.matches ? 0 : 160,
  easing: 'ease-out',
  disabled: true,
  onEnd({ item, oldDraggableIndex, newDraggableIndex }) {
    if (!packBusy && oldDraggableIndex !== newDraggableIndex) {
      void savePackOrder(packSorter.toArray(), item.dataset.packId);
    }
  },
});
packMotion.addEventListener('change', ({ matches }) => packSorter.option('animation', matches ? 0 : 160));

function updatePackControls() {
  const canSort = desktop && !packBusy && packs.size > 1;
  packSorter.option('disabled', !canSort);
  for (const button of packImportButtons) button.disabled = packBusy || !desktop;
  for (const button of packList.querySelectorAll('.pack-remove')) button.disabled = packBusy;
  for (const button of packList.querySelectorAll('.pack-handle')) button.disabled = !canSort;
}

function renderPacks() {
  packList.replaceChildren();
  const active = [...packs.values()].filter(pack => pack.data).length;
  byId('pack-summary').textContent = active ? `${active} 个全局资源包` : '尚未加载资源包';
  byId('pack-manager').lastChild.textContent = packs.size ? '管理' : '导入';
  if (!packs.size) {
    const message = document.createElement('p');
    message.className = 'palette-message';
    message.textContent = packBusy ? '正在读取资源包…' : desktop ? '尚未导入资源包' : '请在桌面应用中导入资源包';
    packList.append(message);
  }
  const displayedPacks = [...packs.values()].reverse();
  for (const pack of displayedPacks) {
    const row = document.createElement('div');
    row.className = 'pack-row';
    row.dataset.packId = pack.id;
    const handle = document.createElement('button');
    handle.className = 'icon-button small pack-handle';
    handle.title = '拖动排序，也可使用方向键';
    handle.setAttribute('aria-label', `调整 ${pack.name} 的顺序`);
    handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
    handle.append(icon('grip-vertical'));
    handle.addEventListener('keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (packBusy || Sortable.active) return;
      const ids = packSorter.toArray();
      const from = ids.indexOf(pack.id);
      const to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ids.length) return;
      ids.splice(from, 1);
      ids.splice(to, 0, pack.id);
      packSorter.sort(ids, true);
      void savePackOrder(ids, pack.id);
    });
    const text = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = pack.name;
    name.title = pack.name;
    const detail = document.createElement('span');
    const kind = pack.kind === 'folder' ? '文件夹' : pack.kind.toUpperCase();
    const summary = [];
    if (pack.data?.states.size) summary.push(`${pack.data.states.size.toLocaleString()} 个方块定义`);
    if (pack.data?.languages.size) {
      summary.push(`${pack.data.languages.size.toLocaleString()} 种语言`);
      detail.title = [...pack.data.languages.keys()].map(localeName).join('、');
    }
    detail.textContent = pack.error ? `加载失败 · ${kind}` : pack.data ? [kind, ...summary].join(' · ') : '正在加载…';
    if (pack.error) detail.title = pack.error;
    text.append(name, detail);
    const remove = document.createElement('button');
    remove.className = 'icon-button small danger pack-remove';
    remove.title = '移除 AppData 中的副本';
    remove.setAttribute('aria-label', `移除 ${pack.name}`);
    remove.append(icon('trash-2'));
    remove.addEventListener('click', () => packAction(async () => {
      await packsOnDisk.remove(pack.id);
      packs.delete(pack.id);
      updateCatalog();
      status(`已移除 ${pack.name}`);
    }));
    row.append(handle, text, remove);
    packList.append(row);
  }
  updatePackControls();
}

for (const panel of packProgressPanels) panel.append(byId('pack-progress-template').content.cloneNode(true));

function showPackProgress(progress) {
  for (const panel of packProgressPanels) {
    panel.hidden = !progress;
    if (!progress) continue;
    const { total, completed = 0, name, stage, processed, files } = progress;
    panel.querySelector('[data-progress-count]').textContent = total ? completed + ' / ' + total : '';
    const label = panel.querySelector('[data-progress-name]');
    label.textContent = name || '当前资源包';
    label.title = label.textContent;
    panel.querySelector('[data-progress-stage]').textContent = files ? stage + ' ' + processed + ' / ' + files : stage;
    const totalBar = panel.querySelector('[data-progress-total]');
    const packBar = panel.querySelector('[data-progress-pack]');
    if (total) {
      totalBar.max = total;
      totalBar.value = Math.min(total, completed + (files ? processed / files : 0));
    } else totalBar.removeAttribute('value');
    if (files) {
      packBar.max = files;
      packBar.value = processed;
    } else packBar.removeAttribute('value');
  }
}

async function loadPack(pack, total, completed) {
  const progress = { total, completed, name: pack.name };
  showPackProgress({ ...progress, stage: '读取文件' });
  return loadArchive(await packsOnDisk.read(pack.id), ({ stage, processed, total: files }) => {
    showPackProgress({ ...progress, stage: stage === 'unpack' ? '解压资源' : '索引文件', processed, files });
  });
}

function packAction(action, refreshList = renderPacks) {
  const pending = packQueue.then(() => runPackAction(action, refreshList));
  packQueue = pending.catch(handleError);
  return pending;
}

async function runPackAction(action, refreshList) {
  packBusy = true;
  const message = byId('pack-error');
  message.hidden = true;
  updatePackControls();
  try { await action(); }
  catch (error) {
    message.textContent = errorMessage(error);
    message.hidden = false;
    if (!byId('pack-dialog').open) handleError(error);
  } finally {
    packBusy = false;
    showPackProgress(null);
    refreshList();
  }
}

function savePackOrder(displayOrder, movedId) {
  return packAction(async () => {
    if (displayOrder.length !== packs.size || displayOrder.some(id => !packs.has(id))) return;
    const ids = [...displayOrder].reverse();
    await packsOnDisk.setOrder(ids);
    packs = new Map(ids.map(id => [id, packs.get(id)]));
    updateCatalog();
    status(`已调整 ${packs.get(movedId).name} 的加载顺序`);
  }, () => {
    const savedOrder = [...packs.keys()].reverse();
    if (packSorter.toArray().some((id, index) => id !== savedOrder[index])) {
      packSorter.sort(savedOrder, true);
    }
    updatePackControls();
    if (byId('pack-dialog').open) {
      packList.querySelector(`[data-pack-id="${CSS.escape(movedId)}"] .pack-handle`)?.focus({ preventScroll: true });
    }
  });
}

async function importPack(path, total, completed, name) {
  showPackProgress({ total, completed, name, stage: '复制到 AppData' });
  const pack = await packsOnDisk.import(path);
  try {
    pack.data = await loadPack(pack, total, completed);
  } catch (error) {
    try {
      await packsOnDisk.remove(pack.id);
    } catch (cleanupError) {
      pack.error = errorMessage(error);
      packs.set(pack.id, pack);
      throw new Error(`${pack.error} 清理副本失败。${errorMessage(cleanupError)}`);
    }
    throw error;
  }
  packs.set(pack.id, pack);
}

async function importPacks(paths) {
  if (!paths.length) return;
  const failures = [];
  const total = paths.length;
  let imported = 0;
  for (const [completed, path] of paths.entries()) {
    const { filename } = fileInfo(path);
    try {
      await importPack(path, total, completed, filename);
      imported++;
    } catch (error) {
      failures.push(`${filename} · ${errorMessage(error)}`);
    }
  }
  if (imported) {
    showPackProgress({ total, completed: total, stage: '更新方块库' });
    try {
      await packsOnDisk.setOrder([...packs.keys()]);
    } catch (error) {
      failures.push('保存资源包顺序失败。' + errorMessage(error));
    }
    updateCatalog();
  }
  status(`已导入 ${imported} / ${total} 个资源包`);
  if (failures.length) throw new Error(failures.join('\n'));
}

async function loadPacks() {
  if (!desktop) return;
  await packAction(async () => {
    showPackProgress({ stage: '查找资源包' });
    for (const pack of await packsOnDisk.list()) packs.set(pack.id, pack);
    renderPacks();
    let completed = 0;
    for (const pack of packs.values()) {
      try { pack.data = await loadPack(pack, packs.size, completed); }
      catch (error) { pack.error = errorMessage(error); }
      completed++;
    }
    if (packs.size) showPackProgress({ total: packs.size, completed, stage: '更新方块库' });
    updateCatalog();
    const failed = [...packs.values()].filter(pack => pack.error).length;
    if (failed) status(`${failed} 个资源包未能加载`);
  });
}

function projectSettings() {
  byId('edit-name').value = build.name;
  const versions = byId('edit-minecraft-version');
  const currentVersion = minecraftVersionFor(build.dataVersion);
  const currentValue = currentVersion ?? String(build.dataVersion);
  const options = MINECRAFT_RELEASES.map(([version]) => new Option(version, version));
  if (!currentVersion) options.unshift(new Option('保留原版本', currentValue));
  versions.replaceChildren(...options);
  versions.value = currentValue;
  byId('project-dialog').showModal();
}

function chooseDroppedStructure(structures) {
  if (structures.length === 1) return structures[0];
  const dialog = byId('drop-structure-dialog');
  const select = byId('drop-structure-file');
  select.replaceChildren(...structures.map(({ file, filename }, index) => {
    const repeated = structures.some((other, i) => i !== index && other.filename === filename);
    return new Option(repeated && desktop ? file : filename);
  }));
  dialog.returnValue = 'cancel';
  dialog.showModal();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      resolve(dialog.returnValue === 'open' ? structures[select.selectedIndex] : null);
    }, { once: true });
  });
}

async function openDroppedFiles(files) {
  const archives = [];
  const structures = [];
  const unsupported = [];
  for (const file of files) {
    const { filename, extension } = fileInfo(desktop ? file : file.name);
    if (STRUCTURE_FORMATS.includes(extension)) structures.push({ file, filename });
    else if (desktop && PACK_ARCHIVE_FORMATS.includes(extension)) archives.push(file);
    else unsupported.push(filename);
  }
  if (archives.length) await packAction(() => importPacks(archives));
  if (structures.length) {
    if (projectBusy) throw new Error('另一个项目文件操作正在进行。');
    const chosen = await chooseDroppedStructure(structures);
    if (chosen) {
      const read = desktop ? readStructureFile : readBrowserStructureFile;
      if (await openEditorProject(() => read(chosen.file))) {
        byId('pack-dialog').close();
        byId('project-dialog').close();
      }
    }
  }
  if (unsupported.length) {
    const formats = desktop ? '支持 ZIP、JAR、NBT、Litematic 和 MCStructure。' : '桌面应用可打开 MCStructure 和导入资源包。';
    handleError(new Error(`无法处理 ${unsupported.join('、')}。${formats}`));
  }
}

async function registerFileDrop() {
  const hint = byId('file-drop-hint');
  const formats = STRUCTURE_FORMATS.map(format => '.' + format).join(' / ');
  byId('file-drop-formats').textContent = desktop ? '.zip / .jar · ' + formats : formats;
  let queue = Promise.resolve();
  const drop = files => {
    hint.hidePopover();
    if (files.length) queue = queue.then(() => openDroppedFiles(files)).catch(handleError);
  };
  if (desktop) {
    await getCurrentWindow().onDragDropEvent(({ payload }) => {
      if (payload.type === 'enter') hint.showPopover();
      if (payload.type === 'leave') hint.hidePopover();
      if (payload.type === 'drop') drop(payload.paths);
    });
    return;
  }
  window.addEventListener('dragover', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    hint.showPopover();
  });
  window.addEventListener('dragleave', event => {
    if (!event.relatedTarget) hint.hidePopover();
  });
  window.addEventListener('drop', event => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    drop([...event.dataTransfer.files]);
  });
}

function setSaveMenu(show) {
  const menu = byId('save-menu');
  menu.hidden = !show;
  byId('save-menu-button').setAttribute('aria-expanded', String(show));
  if (show) menu.querySelector('button').focus();
}

byId('tools').addEventListener('click', event => {
  const button = event.target.closest('[data-tool]');
  if (button) toggleTool(button.dataset.tool);
});
byId('palette-filters').addEventListener('click', event => {
  const button = event.target.closest('[data-category]');
  if (!button) return;
  category = button.dataset.category;
  for (const filter of byId('palette-filters').children) filter.setAttribute('aria-pressed', String(filter === button));
  resetPalette();
});
byId('palette-search').addEventListener('input', resetPalette);
modIdFilter.addEventListener('change', resetPalette);
byId('block-language').addEventListener('change', event => {
  locale = event.target.value;
  localStorage.setItem(LOCALE_KEY, locale);
  updateNames();
  void loadOfficialLanguage();
});
byId('palette').addEventListener('click', event => {
  const button = event.target.closest('[data-block]');
  if (button) chooseBrush(catalog.blocks.get(button.dataset.block).state, true);
});

for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
for (const button of presetButtons) button.addEventListener('click', () => frame(button.dataset.preset));
for (const button of projectionButtons) button.addEventListener('click', () => setProjection(button.dataset.projection));
for (const button of document.querySelectorAll('[data-rotation]')) button.addEventListener('click', () => {
  try { build.transform({ rotation: Number(button.dataset.rotation) }); }
  catch (error) { handleError(error); }
});
byId('work-layer').addEventListener('change', event => {
  const input = event.target;
  if (!input.checkValidity() || !Number.isInteger(input.valueAsNumber)) {
    input.value = viewport?.layer ?? 0;
    handleError(new Error('工作层需要整数 Y 坐标。'));
    return;
  }
  viewport?.setLayer(input.valueAsNumber);
});
byId('transform').addEventListener('submit', event => {
  event.preventDefault();
  try { build.transform({ origin: originFields.map(input => input.valueAsNumber), size: sizeFields.map(input => input.valueAsNumber) }); }
  catch (error) { handleError(error); }
});
byId('project-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const version = byId('edit-minecraft-version').value;
    build.setMetadata(byId('edit-name').value, dataVersionFor(version) ?? Number(version));
    byId('project-dialog').close();
  } catch (error) { handleError(error); }
});

onClick('project-new', () => leaveProject('新建项目', () => newProject()));
onClick('project-open', () => openEditorProject(openProject));
onClick('project-save', () => saveProject());
onClick('project-settings', projectSettings);
onClick('scene-settings', projectSettings);
onClick('save-menu-button', () => setSaveMenu(byId('save-menu').hidden));
for (const button of byId('save-menu').querySelectorAll('button')) button.addEventListener('click', () => {
  saveProject(button.dataset.format).catch(handleError);
});
document.addEventListener('click', event => {
  if (!event.target.closest('.dropdown, #project-save')) setSaveMenu(false);
});
onClick('undo', () => applyHistory('undo'));
onClick('redo', () => applyHistory('redo'));
onClick('copy-selection', copySelection);
onClick('paste-selection', () => toggleTool('paste'));
onClick('grid-toggle', event => event.currentTarget.setAttribute('aria-pressed', String(viewport?.toggleGrid() ?? false)));
onClick('frame', () => frame());
onClick('screenshot', () => saveViewportImage(false));
onClick('export-image', () => saveViewportImage(true));
onClick('select-all', () => { toggleTool('select'); build.select(build.blocks.keys()); });
onClick('delete-selection', () => { if (build.removeSelection()) status('已删除选区'); });
onClick('pack-manager', () => { renderPacks(); byId('pack-dialog').showModal(); });
for (const button of packImportButtons) {
  button.addEventListener('click', () => packAction(async () => {
    await importPacks(await packsOnDisk.choose(button.dataset.packType));
  }));
}
onClick('help', () => byId('help-dialog').showModal());

function renderMcp() {
  const online = Boolean(mcp.url && !mcp.error);
  const element = byId('mcp-status');
  element.classList.toggle('online', online);
  element.classList.toggle('offline', Boolean(mcp.error));
  const description = online ? 'MCP 服务正在监听本机连接。' : mcp.error || '正在启动 MCP 服务…';
  element.title = description;
  byId('mcp-dialog-status').textContent = description;
  byId('mcp-address').value = mcp.url;
  byId('copy-mcp').disabled = !mcp.url;
}

onClick('mcp-status', () => { renderMcp(); byId('mcp-dialog').showModal(); });
onClick('copy-mcp', async () => {
  const input = byId('mcp-address');
  input.select();
  if (!document.execCommand('copy')) await navigator.clipboard.writeText(mcp.url);
  byId('mcp-dialog-status').textContent = '已复制连接地址。';
});

const fileShortcuts = { n: 'project-new', o: 'project-open', s: 'project-save', 'shift+s': 'save-menu-button' };
const clipboardShortcuts = { c: 'copy-selection', v: 'paste-selection' };

document.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || document.querySelector('dialog[open]')) return;
  const editing = event.target.isContentEditable || event.target.matches?.('input, select, textarea');
  const key = event.key.toLowerCase();
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    const chord = event.shiftKey ? 'shift+' + key : key;
    if (Object.hasOwn(fileShortcuts, chord)) {
      event.preventDefault();
      if (!event.repeat) byId(fileShortcuts[chord]).click();
    } else if (!editing && Object.hasOwn(clipboardShortcuts, chord)) {
      const button = byId(clipboardShortcuts[chord]);
      if (button.disabled || (chord === 'c' && window.getSelection()?.isCollapsed === false)) return;
      event.preventDefault();
      if (!event.repeat) button.click();
    } else if (!editing && ['z', 'shift+z', 'y'].includes(chord)) {
      event.preventDefault();
      applyHistory(chord === 'z' ? 'undo' : 'redo');
    } else if (!editing && chord === 'a') {
      event.preventDefault();
      toggleTool('select');
      build.select(build.blocks.keys());
    }
    return;
  }
  if (key === 'escape' && !event.altKey && !event.repeat) {
    if (tool === 'paste') {
      setSaveMenu(false);
      toggleTool('select');
    } else if (!editing) {
      firstCorner = null;
      setSaveMenu(false);
      build.select([]);
      status(tools[tool]);
    }
    return;
  }
  if (editing || event.altKey) return;
  const shortcut = { v: 'select', p: 'place', r: 'replace', e: 'erase', b: 'box', g: 'fill', i: 'pick' };
  if (shortcut[key]) toggleTool(shortcut[key]);
  if (key === 'f') frame();
  if (key === 'delete') build.removeSelection();
  if (key === '/') { event.preventDefault(); byId('palette-search').focus(); }
});

try {
  viewport = new Viewport(byId('viewport'), build, catalog, {
    click: clickScene,
    hover,
    orientation: quaternion => drawCompass(byId('compass'), quaternion),
  });
} catch (error) {
  byId('view-error').textContent = `无法启动 WebGL 2。${errorMessage(error)}`;
  byId('view-error').hidden = false;
  byId('screenshot').disabled = true;
  for (const button of [...projectionButtons, ...presetButtons]) button.disabled = true;
  console.error(error);
}
build.onChange(updateScene);
updateScene();
renderPalette();
renderLanguages();
renderBrush();
renderPacks();
renderMcp();

await guardWindowClose().catch(handleError);
const restoringPacks = loadPacks();
await registerFileDrop().catch(handleError);
await restoringPacks;
if (desktop) {
  try {
    const editor = {
      projectInfo,
      applyHistory,
      copySelection,
      newProject: ({ name, minecraft_version, data_version, discard_unsaved }) => projectAction(() => {
        requireSavedProject(discard_unsaved);
        const dataVersion = minecraft_version === undefined ? data_version : dataVersionFor(minecraft_version);
        if (minecraft_version !== undefined && dataVersion === undefined) {
          throw new Error('Choose a supported Minecraft Java release, e.g. 1.21.1.');
        }
        return newProject(name, dataVersion);
      }),
      openProject: ({ path, discard_unsaved }) => projectAction(async () => {
        requireSavedProject(discard_unsaved);
        const file = await readStructureFile(path);
        requireSavedProject(discard_unsaved);
        return showOpenedProject(file.project, file);
      }),
      saveProject: saveMcpProject,
      cameraInfo: () => viewport?.cameraInfo() ?? null,
      setCamera: (position, target, projection) => {
        if (!viewport) throw new Error('The viewport is unavailable.');
        viewport.setCamera(position, target, projection);
        currentPreset = null;
        updateCameraButtons();
      },
      setProjection: projection => {
        if (!viewport) throw new Error('The viewport is unavailable.');
        setProjection(projection);
      },
      frame: (preset, projection) => {
        if (!viewport) throw new Error('The viewport is unavailable.');
        frame(preset, projection);
      },
      capture: (width, options) => {
        if (!viewport) throw new Error('The viewport is unavailable.');
        return viewport.capture(width, options);
      },
      renderBlockStates: (states, followCamera) => {
        if (!viewport) throw new Error('The viewport is unavailable.');
        return modelPreview.renderBlockStates(catalog, states, viewport.blockPreviewCamera(followCamera));
      },
      packs: () => [...packs.values()].map(({ id, name, kind, data }) => ({ id, name, kind, loaded: Boolean(data) })),
      catalog: () => catalog,
      status,
    };
    mcp = await connectMcp(editorMcp(build, editor));
    if (mcp.error) mcp.error = `MCP 启动失败。${mcp.error}`;
  } catch (error) { mcp = { url: '', error: errorMessage(error) }; }
  renderMcp();
}
