import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const handler = main.slice(main.indexOf("handleApp('capture-region-image'"), main.indexOf("handleApp('open-external-url'"));

function harness() {
  let capture;
  const png = Buffer.from([137, 80, 78, 71]);
  const context = vm.createContext({
    Blob, path, Date,
    app: { getPath: () => '/fixture/temp' },
    fs: { mkdirSync: vi.fn(), writeFileSync: vi.fn() },
    clipboard: { write: vi.fn(async () => {}) },
    ClipboardItem: class { constructor(data) { this.data = data; } },
    mainWindow: {
      isDestroyed: () => false,
      webContents: { capturePage: vi.fn(async () => ({ isEmpty: () => false, toPNG: () => png, toDataURL: () => 'data:image/png;base64,fixture' })) },
    },
    handleApp: (channel, fn) => { capture = fn; },
  });
  vm.runInContext(handler, context);
  return { context, capture, png };
}

const rect = { x: 0, y: 0, width: 100, height: 100, viewportWidth: 200, viewportHeight: 200 };

describe('image capture with the Electron clipboard API', () => {
  it('writes PNG through ClipboardItem and saves identical bytes', async () => {
    const { context, capture, png } = harness();
    const result = await capture(null, rect, { name: 'preview' });
    expect(result.success).toBe(true);
    expect(result.copiedToClipboard).toBe(true);
    const item = context.clipboard.write.mock.calls[0][0][0];
    expect(item.data['image/png'].type).toBe('image/png');
    expect(Buffer.from(await item.data['image/png'].arrayBuffer())).toEqual(png);
    expect(context.fs.writeFileSync).toHaveBeenCalledWith(result.path, png);
  });

  it('waits for clipboard completion before claiming success', async () => {
    const { context, capture } = harness();
    let complete;
    context.clipboard.write.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
    const pending = capture(null, rect);
    await vi.waitFor(() => expect(context.clipboard.write).toHaveBeenCalledOnce());
    expect(context.fs.writeFileSync).not.toHaveBeenCalled();
    complete();
    expect((await pending).success).toBe(true);
  });

  it('reports asynchronous clipboard errors', async () => {
    const { context, capture } = harness();
    context.clipboard.write.mockRejectedValue(new Error('Clipboard unavailable'));
    expect(await capture(null, rect)).toEqual({ success: false, error: 'Clipboard unavailable' });
    expect(context.fs.writeFileSync).not.toHaveBeenCalled();
  });

  it('rejects a region clipped outside the app before capture or clipboard access', async () => {
    const { context, capture } = harness();
    const result = await capture(null, { ...rect, x: 199 });
    expect(result.success).toBe(false);
    expect(context.mainWindow.webContents.capturePage).not.toHaveBeenCalled();
    expect(context.clipboard.write).not.toHaveBeenCalled();
  });
});
