import { describe, expect, it } from 'vitest';
import { addedDocIds, CLEAN_TOOLS, EDIT_MODE_KEY, isCleanTool, modeReducer } from './editMode';
import { TOOLS, toolForKey } from '../components/toolActions';
import type { ToolId } from '../core/types';

describe('modeReducer', () => {
  it('toggle: clean → edit keeps the tool', () => {
    expect(modeReducer(false, { type: 'toggle', tool: 'rectArea' })).toEqual({ editMode: true });
  });
  it('toggle: edit → clean keeps a clean tool, drops an edit-only tool to the hand', () => {
    expect(modeReducer(true, { type: 'toggle', tool: 'calibrate' })).toEqual({ editMode: false });
    expect(modeReducer(true, { type: 'toggle', tool: 'note' })).toEqual({ editMode: false, tool: 'pan' });
    expect(modeReducer(true, { type: 'toggle', tool: 'count' })).toEqual({ editMode: false, tool: 'pan' });
  });
  it('a tool outside the clean dock switches to edit mode', () => {
    for (const t of ['note', 'text', 'rect', 'count', 'pen', 'link'] as ToolId[]) {
      expect(modeReducer(false, { type: 'toolChanged', tool: t })).toEqual({ editMode: true });
    }
  });
  it('clean tools never change the mode', () => {
    for (const t of CLEAN_TOOLS) {
      expect(modeReducer(false, { type: 'toolChanged', tool: t })).toEqual({ editMode: false });
      expect(modeReducer(true, { type: 'toolChanged', tool: t })).toEqual({ editMode: true });
    }
  });
  it('opening a file always returns to the clean mode', () => {
    expect(modeReducer(true, { type: 'fileOpened', tool: 'arrow' })).toEqual({ editMode: false, tool: 'pan' });
    expect(modeReducer(true, { type: 'fileOpened', tool: 'deduct' })).toEqual({ editMode: false });
    expect(modeReducer(false, { type: 'fileOpened', tool: 'pan' })).toEqual({ editMode: false });
  });
  it('exit', () => {
    expect(modeReducer(true, { type: 'exit', tool: 'highlight' })).toEqual({ editMode: false, tool: 'pan' });
  });
});

describe('shortcut → mode', () => {
  it('every clean tool exists in TOOLS and the area menu is fully in the clean dock', () => {
    for (const t of CLEAN_TOOLS) expect(TOOLS.some((x) => x.id === t)).toBe(true);
    for (const t of TOOLS.filter((x) => x.menu === 'area')) expect(isCleanTool(t.id)).toBe(true);
  });
  it('dock keys stay in clean mode, markup keys open edit mode', () => {
    const mode = (code: string) => {
      const t = toolForKey(code);
      return t ? modeReducer(false, { type: 'toolChanged', tool: t }).editMode : null;
    };
    for (const k of ['KeyV', 'KeyH', 'KeyC', 'KeyA', 'KeyB', 'KeyD', 'KeyO']) expect(mode(k)).toBe(false);
    for (const k of ['KeyN', 'KeyK', 'KeyX', 'KeyR', 'KeyI', 'KeyJ', 'KeyY', 'KeyZ', 'KeyU', 'KeyW', 'KeyP', 'KeyG']) expect(mode(k)).toBe(true);
  });
  it('the edit-mode key is not taken by a tool or a shell shortcut', () => {
    expect(toolForKey(EDIT_MODE_KEY)).toBeUndefined();
    expect(['KeyE', 'KeyM', 'KeyT', 'KeyS', 'KeyF']).not.toContain(EDIT_MODE_KEY);
  });
});

describe('addedDocIds', () => {
  it('reports only new ids', () => {
    expect(addedDocIds(['a', 'b'], ['a', 'b', 'c'])).toEqual(['c']);
    expect(addedDocIds(['a', 'b'], ['b'])).toEqual([]);
    expect(addedDocIds([], ['x'])).toEqual(['x']);
  });
});
