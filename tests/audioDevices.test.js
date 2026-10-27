import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { parseConfig } from '../src/config/parser.js';
import { serializeConfig, createDefaultConfig } from '../src/config/serializer.js';

// Exercise the actual main-process function without starting Electron or touching APO.
const main = readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
const enumeration = main.slice(
  main.indexOf('function listWindowsAudioDevices()'),
  main.indexOf('function getMainConfigPath()')
);

function enumerate(run, platform = 'win32') {
  const context = vm.createContext({ process: { platform }, execFileSync: run, console });
  vm.runInContext(enumeration, context);
  return context.listWindowsAudioDevices();
}

describe('Windows audio device encoding', () => {
  it('does not invoke PowerShell on other platforms', () => {
    expect(enumerate(() => { throw new Error('Unexpected subprocess'); }, 'linux')).toEqual([]);
  });

  it('handles PowerShell empty, single-device and multiple-device JSON results', () => {
    expect(enumerate(() => '')).toEqual([]);
    expect(enumerate(() => '{"name":"扬声器"}')).toEqual([{ name: '扬声器' }]);
    expect(enumerate(() => '[{"name":"扬声器"},{"name":"麦克风"}]')).toHaveLength(2);
  });

  // Hosted Windows runners can cold-start PowerShell slowly. Allow its existing
  // 10-second subprocess deadline plus assertion overhead, rather than 5 seconds.
  it.skipIf(process.platform !== 'win32').each([936, 866, 1251])(
    'preserves Unicode through PowerShell and APO starting from code page %i', (codePage) => {
    const guid = '{12345678-1234-1234-1234-123456789abc}';
    const name = 'Динамики 扬声器 한국어 🎧';
    const connection = 'FiiO K7';
    // Simulate registry data only. Run the production enumeration script and real
    // Windows PowerShell pipe, starting from a non-UTF-8 console code page.
    const registryFixture = `
[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(${codePage})
function Test-Path { param($LiteralPath) return -not $LiteralPath.Contains('Capture') }
function Get-ChildItem {
  [pscustomobject]@{ PSPath = 'HKLM:\\fixture'; PSChildName = '${guid}' }
}
function Get-ItemProperty {
  param($LiteralPath)
  if ($LiteralPath.EndsWith('Properties')) {
    [pscustomobject]@{
      '{a45c254e-df1c-4efd-8020-67d146a850e0},2' = '${name}'
      '{b3f8fa53-0004-438e-9003-51a46e139bfc},6' = '${connection}'
    }
  } else { [pscustomobject]@{ DeviceState = 1 } }
}
`;
    const devices = enumerate((exe, args, options) => {
      const patchedArgs = [...args];
      patchedArgs[patchedArgs.length - 1] = registryFixture + patchedArgs.at(-1);
      return execFileSync(exe, patchedArgs, options);
    });
    expect(devices).toHaveLength(1);
    expect(devices[0].name).toBe(`${name} (${connection})`);
    expect(devices[0].apoValue).toBe(`${name} ${connection} ${guid}`);
    expect(devices[0].active).toBe(true);
    const config = { ...createDefaultConfig(), device: devices[0].apoValue, preamp: -4.5 };
    const text = serializeConfig(config);
    expect(text).toContain(`Device: ${name} ${connection} ${guid}`);
    expect(parseConfig(text).device).toBe(config.device);
    expect(text).not.toContain('\uFFFD');
  }, 15000);
});
