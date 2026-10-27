import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Exercise the production registration and tray code without reserving real keys.
const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const profiles = main.slice(main.indexOf('const QUICK_EQ_PROFILES ='), main.indexOf("app.commandLine.appendSwitch"));
const trayCode = main.slice(main.indexOf('function updateTrayMenu()'), main.indexOf('function setupWindowsUserTasks()'));

function harness(saved = undefined) {
  let persisted = saved;
  let menu;
  const registered = new Map();
  const fs = {
    readFileSync: vi.fn(() => { if (persisted === undefined) throw new Error('ENOENT'); return persisted; }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((file, text) => { persisted = text; }),
  };
  const context = vm.createContext({
    fs, path, console, setTimeout, clearTimeout,
    shortcutSettingsPath: path.join('fixture', 'shortcuts.json'),
    dialog: { showErrorBox: vi.fn() },
    globalShortcut: {
      register: vi.fn((key, action) => { registered.set(key, action); return true; }),
      unregisterAll: vi.fn(() => registered.clear()),
    },
    showOrHideMainWindow: vi.fn(), applyQuickEqProfile: vi.fn(), adjustTrayPreamp: vi.fn(),
    setTrayPreamp: vi.fn(), getPresetsList: () => [], buildDeviceTrayItems: () => [],
    Menu: { buildFromTemplate: items => { menu = items; return items; } },
    tray: { setContextMenu: vi.fn() },
  });
  vm.runInContext(`let globalShortcutsEnabled = false; let trayMenuRefreshTimer = null; ${profiles}\n${trayCode}`, context);
  // The real scheduler is separately exercised by Electron; keep tests timer-free.
  context.scheduleTrayMenuRefresh = vi.fn();
  return { context, registered, fs, getMenu: () => menu, saved: () => persisted };
}

describe('opt-in global shortcuts (issue #29)', () => {
  it.each([undefined, '{bad json', '{}', '{"enabled":"true"}', '{"enabled":false}'])(
    'defaults to disabled for absent or invalid settings: %s', saved => {
      const { context, registered } = harness(saved);
      expect(context.loadGlobalShortcutSettings()).toBe(false);
      context.registerGlobalShortcuts();
      expect(registered.size).toBe(0);
    },
  );

  it('registers only on opt-in, avoids AltGr combinations, and releases all keys on opt-out', () => {
    const { context, registered, saved } = harness();
    expect(context.setGlobalShortcutsEnabled(true)).toBe(true);
    expect(context.loadGlobalShortcutSettings()).toBe(true);
    expect(JSON.parse(saved())).toEqual({ enabled: true });
    expect(registered.size).toBe(9);
    expect([...registered.keys()].every(key => !key.includes('Alt'))).toBe(true);
    registered.get('CommandOrControl+Shift+2')();
    expect(context.applyQuickEqProfile).toHaveBeenCalledWith('treble-boost');
    registered.get('CommandOrControl+Shift+Down')();
    expect(context.adjustTrayPreamp).toHaveBeenCalledWith(-1);
    expect(context.setGlobalShortcutsEnabled(false)).toBe(true);
    expect(registered.size).toBe(0);
    expect(context.loadGlobalShortcutSettings()).toBe(false);
  });

  it('keeps the previous state if persistence fails', () => {
    const { context, registered, fs } = harness();
    fs.writeFileSync.mockImplementation(() => { throw new Error('Access denied'); });
    expect(context.setGlobalShortcutsEnabled(true)).toBe(false);
    expect(registered.size).toBe(0);
    expect(context.dialog.showErrorBox).toHaveBeenCalledWith('Could not save shortcut settings', 'Access denied');
  });

  it('offers a tray checkbox and hides accelerator labels until enabled', () => {
    const { context, getMenu, registered } = harness();
    context.updateTrayMenu();
    let menu = getMenu();
    const toggle = menu.find(item => item.label === 'Enable Global Shortcuts');
    expect(toggle.checked).toBe(false);
    expect(menu.find(item => item.label === 'Quick EQ').submenu.every(item => item.accelerator === undefined)).toBe(true);
    toggle.click({ checked: true });
    context.updateTrayMenu();
    menu = getMenu();
    expect(menu.find(item => item.label === 'Enable Global Shortcuts').checked).toBe(true);
    expect(menu.find(item => item.label === 'Quick EQ').submenu.every(item => registered.has(item.accelerator))).toBe(true);
  });
});
