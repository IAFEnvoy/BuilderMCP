import { saveStructureFile } from './desktop.js';
import { boundsOf, boxBetween, inBox, point } from './scene.js';

function page(items, offset = 0, limit = 50, maximum = 1000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > maximum) throw new Error(`offset must be non-negative and limit must be 1–${maximum}.`);
  return { total: items.length, offset, items: items.slice(offset, offset + limit), nextOffset: offset + limit < items.length ? offset + limit : null };
}

export function editorMcp(scene, editor) {
  const handlers = {
    get_scene: () => ({
      ...editor.projectInfo(), language: editor.catalog().locale, bounds: scene.bounds,
      selection: { count: scene.selection.size, bounds: boundsOf(scene.selected) },
      camera: editor.cameraInfo(), resourcePacks: editor.packs(),
    }),
    new_project: args => editor.newProject(args),
    open_project: args => editor.openProject(args),
    save_project: args => editor.saveProject(args),
    list_blocks: ({ from, to, offset, limit }) => {
      const bounds = from === undefined && to === undefined ? null : boxBetween(point(from), point(to));
      const blocks = [...scene.blocks.values()].filter(({ pos }) => !bounds || inBox(pos, bounds));
      blocks.sort((a, b) => a.pos[1] - b.pos[1] || a.pos[2] - b.pos[2] || a.pos[0] - b.pos[0]);
      return page(blocks, offset, limit);
    },
    search_palette: ({ query = '', mod_id, offset, limit }) => {
      if (typeof query !== 'string' || query.length > 256) throw new Error('query must be a string of at most 256 characters.');
      if (mod_id !== undefined && (typeof mod_id !== 'string' || !/^[a-z0-9_.-]+$/.test(mod_id))) {
        throw new Error('mod_id must be a Minecraft resource namespace, e.g. minecraft.');
      }
      const blocks = editor.catalog().find(query, 'all', mod_id);
      return page(blocks.map(({ name, label, state, properties }) => ({ name, label, state, properties })), offset, limit, 100);
    },
    set_blocks: ({ blocks }) => {
      if (!Array.isArray(blocks) || blocks.length > 20_000) throw new Error('Provide a blocks array with up to 20,000 entries.');
      const changes = scene.setBlocks(blocks.map(({ pos, state }) => ({ pos, state: state === null ? null : editor.catalog().state(state) })));
      return { changes, blockCount: scene.blocks.size };
    },
    fill_box: ({ from, to, state, hollow = false }) => {
      if (typeof hollow !== 'boolean') throw new Error('hollow must be a boolean.');
      return { changes: scene.fillBox(from, to, editor.catalog().state(state), hollow), blockCount: scene.blocks.size };
    },
    remove_box: ({ from, to }) => ({ changes: scene.removeBox(from, to), blockCount: scene.blocks.size }),
    select_box: ({ from, to }) => ({ count: scene.selectBox(from, to), bounds: boundsOf(scene.selected) }),
    copy_selection: () => editor.copySelection(),
    paste_selection: ({ origin }) => ({ changes: scene.pasteSelection(origin), count: scene.selection.size, bounds: boundsOf(scene.selected) }),
    transform_selection: args => ({ changes: scene.transform(args), count: scene.selection.size, bounds: boundsOf(scene.selected) }),
    undo_redo: ({ action }) => {
      if (action !== 'undo' && action !== 'redo') throw new Error('action must be undo or redo.');
      return { applied: editor.applyHistory(action), blockCount: scene.blocks.size };
    },
    set_camera: ({ preset, position, target, projection }) => {
      const explicitPose = position !== undefined || target !== undefined;
      if (preset !== undefined) {
        if (explicitPose) throw new Error('Choose a preset or an explicit camera position and target.');
        editor.frame(preset, projection);
      } else if (explicitPose) {
        editor.setCamera(position, target, projection);
      } else if (projection !== undefined) {
        editor.setProjection(projection);
      } else {
        throw new Error('Provide a preset, projection, or a camera position and target.');
      }
      return editor.cameraInfo();
    },
    capture_screenshot: ({ width, transparent = false }) => {
      if (typeof transparent !== 'boolean') throw new Error('transparent must be a boolean.');
      return editor.capture(width, { transparent });
    },
    render_block_states: ({ states, follow_camera = false }) => {
      if (!Array.isArray(states) || states.length < 1 || states.length > 32) throw new Error('Provide a states array with 1–32 entries.');
      if (typeof follow_camera !== 'boolean') throw new Error('follow_camera must be a boolean.');
      const catalog = editor.catalog();
      return editor.renderBlockStates(states.map(state => catalog.state(state)), follow_camera);
    },
    export_structure: ({ format }) => {
      if (!scene.blocks.size) throw new Error('Place blocks in the scene before exporting.');
      return saveStructureFile(scene.snapshot(), null, format, false, { preserveOrigin: false });
    },
  };
  return async (name, args) => {
    if (!Object.hasOwn(handlers, name)) throw new Error(`Unknown tool ${name}`);
    const result = await handlers[name](args);
    if (['set_blocks', 'fill_box', 'remove_box', 'paste_selection', 'transform_selection'].includes(name)) editor.status('MCP 修改了场景');
    return result;
  };
}
