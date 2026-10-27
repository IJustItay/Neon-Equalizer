import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { ParametricEQ } from '../src/components/parametricEQ.js';

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const fragment = (from, to) => main.slice(main.indexOf(`function ${from}(`), main.indexOf(`function ${to}(`));
const attack = '\"><img src=x onerror=alert(1)>';

// Record the separate HTML and DOM-property writes, so a regression that moves
// imported text back into markup fails without executing the payload.
function element() {
  const selectors = new Map();
  return {
    innerHTML: '', textContent: '', children: [], dataset: {}, style: {},
    classList: { add: vi.fn(), remove: vi.fn(), toggle: vi.fn() },
    addEventListener: vi.fn(),
    appendChild(child) { this.children.push(child); },
    querySelector(selector) {
      if (!selectors.has(selector)) selectors.set(selector, element());
      return selectors.get(selector);
    },
    querySelectorAll(selector) { return [this.querySelector(`${selector}:0`), this.querySelector(`${selector}:1`)]; },
  };
}

function documentFixture() {
  const ids = new Map();
  return {
    createElement: () => element(),
    getElementById(id) { if (!ids.has(id)) ids.set(id, element()); return ids.get(id); },
  };
}

function contextFor(config = {}) {
  return vm.createContext({ document: documentFixture(), appState: { config }, markDirty: vi.fn(), setTimeout: vi.fn() });
}

describe('untrusted renderer text stays out of HTML', () => {
  it('renders notification and exception messages as text', () => {
    const context = contextFor();
    vm.runInContext(fragment('showToast', 'escapeHtml'), context);
    context.showToast(attack, 'error');
    const toast = context.document.getElementById('toast-container').children[0];
    expect(toast.innerHTML).not.toContain(attack);
    expect(toast.children[0].textContent).toBe(attack);
    expect(toast.innerHTML).toContain('<svg');
  });

  it('keeps copy expressions literal and editable', () => {
    const copy = { target: attack, expression: `L + ${attack}` };
    const context = contextFor({ copies: [copy] });
    vm.runInContext(fragment('renderCopyRoutes', 'initDelay'), context);
    context.renderCopyRoutes();
    const row = context.document.getElementById('copy-routes-list').children[0];
    expect(row.innerHTML).not.toContain(attack);
    const inputs = row.querySelectorAll('.filter-input');
    expect(inputs[0].value).toBe(copy.target);
    expect(inputs[1].value).toBe(copy.expression);
    inputs[1].addEventListener.mock.calls[0][1]({ target: { value: 'L+0.5*R' } });
    expect(copy.expression).toBe('L+0.5*R');
    expect(context.markDirty).toHaveBeenCalledOnce();
  });

  it('assigns delay values through an input property and preserves numeric editing', () => {
    const delay = { value: attack, unit: 'ms' };
    const context = contextFor({ delays: [delay] });
    vm.runInContext(fragment('renderDelays', 'initEffects'), context);
    context.renderDelays();
    const row = context.document.getElementById('delay-list').children[0];
    expect(row.innerHTML).not.toContain(attack);
    const input = row.querySelector('input');
    expect(input.value).toBe(attack);
    input.addEventListener.mock.calls[0][1]({ target: { value: '12.5' } });
    expect(delay.value).toBe(12.5);
    expect(context.markDirty).toHaveBeenCalledOnce();
  });

  it('keeps imported filter values and colors out of row HTML', () => {
    const previous = globalThis.document;
    globalThis.document = documentFixture();
    try {
      const container = element();
      const eq = new ParametricEQ(container, vi.fn());
      eq.filters = [{ id: 'test', enabled: true, type: 'PK', frequency: attack, color: attack, gain: 1.5, q: 0.707 }];
      eq._render();
      const row = container.children[0];
      expect(row.innerHTML).not.toContain(attack);
      expect(row.querySelector('.filter-freq').value).toBe(attack);
      expect(row.querySelector('.filter-gain').value).toBe('1.5');
      expect(row.querySelector('.filter-q').value).toBe('0.707');
      expect(row.querySelector('.filter-color-dot').style.backgroundColor).toBe(attack);
    } finally {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    }
  });

  it('escapes remote legend labels and rejects color attribute injection', () => {
    const context = contextFor({ filters: [] });
    Object.assign(context, {
      freqGraph: { curveVisibility: { eq: false }, measurementData: [{}], measurementMeta: { label: attack, color: attack } },
      graphNormalizeScope: { name: attack },
      syncGraphFeatureControls: vi.fn(), updateAutoEQButtonState: vi.fn(),
      describeGraphNormalization: () => '750 Hz',
    });
    vm.runInContext(fragment('escapeHtml', 'initTargetPicker') + fragment('updateGraphLegend', 'initNavigation'), context);
    context.updateGraphLegend();
    const html = context.document.getElementById('graph-legend').innerHTML;
    expect(html).not.toContain(attack);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(html).toContain('value="#888"');
  });
});
