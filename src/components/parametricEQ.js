/**
 * Parametric EQ Panel Component
 * Manages filter rows with all APO filter types
 */

import { FILTER_TYPES, generateFilterColors } from '../config/parser.js';

const filterColors = generateFilterColors(20);

// Filter type options with required fields
const FILTER_TYPE_CONFIG = {
  'PK':       { hasGain: true, hasQ: true, label: 'Peaking (PK)' },
  'PEQ':      { hasGain: true, hasQ: true, label: 'Peaking (PEQ)' },
  'Modal':    { hasGain: true, hasQ: true, label: 'Modal' },
  'LP':       { hasGain: false, hasQ: false, label: 'Low-Pass' },
  'LPQ':      { hasGain: false, hasQ: true, label: 'Low-Pass (Q)' },
  'HP':       { hasGain: false, hasQ: false, label: 'High-Pass' },
  'HPQ':      { hasGain: false, hasQ: true, label: 'High-Pass (Q)' },
  'BP':       { hasGain: false, hasQ: true, label: 'Band-Pass' },
  'LS':       { hasGain: true, hasQ: true, label: 'Low-Shelf' },
  'LSC':      { hasGain: true, hasQ: true, label: 'Low-Shelf (C)' },
  'LS 6dB':   { hasGain: true, hasQ: false, label: 'Low-Shelf 6dB' },
  'LS 12dB':  { hasGain: true, hasQ: false, label: 'Low-Shelf 12dB' },
  'HS':       { hasGain: true, hasQ: true, label: 'High-Shelf' },
  'HSC':      { hasGain: true, hasQ: true, label: 'High-Shelf (C)' },
  'HS 6dB':   { hasGain: true, hasQ: false, label: 'High-Shelf 6dB' },
  'HS 12dB':  { hasGain: true, hasQ: false, label: 'High-Shelf 12dB' },
  'NO':       { hasGain: false, hasQ: true, label: 'Notch' },
  'AP':       { hasGain: false, hasQ: true, label: 'All-Pass' },
  'IIR':      { hasGain: false, hasQ: false, label: 'Custom IIR' },
};

// Presets
const PRESETS = {
  flat: [],
  'bass-boost': [
    { type: 'LS', frequency: 100, gain: 6, q: 0.707 },
    { type: 'PK', frequency: 60, gain: 4, q: 1.0 },
  ],
  'treble-boost': [
    { type: 'HS', frequency: 8000, gain: 5, q: 0.707 },
    { type: 'PK', frequency: 12000, gain: 3, q: 1.0 },
  ],
  vocal: [
    { type: 'PK', frequency: 200, gain: -2, q: 1.0 },
    { type: 'PK', frequency: 3000, gain: 4, q: 1.5 },
    { type: 'PK', frequency: 5000, gain: 2, q: 2.0 },
  ],
  'v-shape': [
    { type: 'PK', frequency: 60, gain: 5, q: 0.8 },
    { type: 'PK', frequency: 200, gain: -3, q: 1.0 },
    { type: 'PK', frequency: 1000, gain: -4, q: 0.7 },
    { type: 'PK', frequency: 4000, gain: -2, q: 1.0 },
    { type: 'PK', frequency: 12000, gain: 5, q: 0.8 },
  ],
  loudness: [
    { type: 'PK', frequency: 40, gain: 8, q: 0.8 },
    { type: 'PK', frequency: 80, gain: 5, q: 1.0 },
    { type: 'PK', frequency: 1000, gain: -2, q: 0.5 },
    { type: 'PK', frequency: 8000, gain: 4, q: 1.0 },
    { type: 'PK', frequency: 14000, gain: 6, q: 0.8 },
  ]
};

export class ParametricEQ {
  constructor(container, onChange) {
    this.container = container;
    this.onChange = onChange;
    this.filters = [];
    this.selectedFilterId = null;
  }

  setFilters(filters) {
    this.filters = filters.map(f => ({ channel: 'all', ...f }));
    this._reindexFilters();
    this._render();
  }

  getFilters() {
    return this.filters;
  }

  addFilter(params = {}) {
    const idx = this.filters.length;
    const filter = {
      id: `filter_${Date.now()}_${idx}`,
      enabled: true,
      type: params.type || 'PK',
      frequency: params.frequency || 1000,
      gain: params.gain !== undefined ? params.gain : 0,
      q: params.q || 1.0,
      channel: params.channel || 'all',
      bw: null,
      iirOrder: null,
      iirCoefficients: null,
      t60: null,
      color: filterColors[idx % filterColors.length],
      index: idx
    };
    this.filters.push(filter);
    this._render();
    this._notify();
    return filter;
  }

  removeFilter(id) {
    this.filters = this.filters.filter(f => f.id !== id);
    if (this.selectedFilterId === id) this.selectedFilterId = null;
    this._reindexFilters();
    this._render();
    this._notify();
  }

  duplicateFilter(id) {
    const source = this.filters.find(f => f.id === id);
    if (!source) return null;

    const copyIndex = this.filters.indexOf(source) + 1;
    const nextFrequency = source.frequency
      ? Math.min(24000, Math.max(1, Math.round(source.frequency * 1.03 * 10) / 10))
      : 1000;
    const copy = {
      ...JSON.parse(JSON.stringify(source)),
      id: `filter_${Date.now()}_${this.filters.length}`,
      frequency: nextFrequency,
      color: filterColors[this.filters.length % filterColors.length]
    };

    this.filters.splice(copyIndex, 0, copy);
    this.selectedFilterId = copy.id;
    this._reindexFilters();
    this._render();
    this._notify();
    return copy;
  }

  updateFilter(id, updates) {
    const filter = this.filters.find(f => f.id === id);
    if (filter) {
      Object.assign(filter, updates);
      this._notify();
    }
  }

  selectFilter(id) {
    this.selectedFilterId = id;
    this.container.querySelectorAll('.filter-row').forEach(row => {
      row.classList.toggle('selected', row.dataset.filterId === id);
    });
  }

  loadPreset(name) {
    if (!Object.prototype.hasOwnProperty.call(PRESETS, name)) return;
    const preset = PRESETS[name];
    this.filters = preset.map((p, i) => ({
      id: `preset_${Date.now()}_${i}`,
      enabled: true,
      type: p.type || 'PK',
      frequency: p.frequency || 1000,
      gain: p.gain !== undefined ? p.gain : 0,
      q: p.q || 1.0,
      channel: 'all',
      bw: null,
      iirOrder: null,
      iirCoefficients: null,
      t60: null,
      color: filterColors[i % filterColors.length],
      index: i
    }));
    this._render();
    this._notify();
  }

  updateFilterFromGraph(filter) {
    // Update the UI inputs for a filter changed by graph drag
    const row = this.container.querySelector(`[data-filter-id="${filter.id}"]`);
    if (!row) return;
    const freqInput = row.querySelector('.filter-freq');
    const gainInput = row.querySelector('.filter-gain');
    const qInput = row.querySelector('.filter-q');
    if (freqInput) freqInput.value = filter.frequency;
    if (gainInput) gainInput.value = filter.gain?.toFixed(1) || '0';
    if (qInput && filter.q !== null && filter.q !== undefined) qInput.value = filter.q.toFixed(3);
  }

  _reindexFilters() {
    this.filters.forEach((filter, index) => {
      filter.index = index;
      if (!filter.color) filter.color = filterColors[index % filterColors.length];
    });
  }

  _notify() {
    if (this.onChange) this.onChange(this.filters);
  }

  _render() {
    this.container.innerHTML = '';

    if (this.filters.length === 0) {
      this.container.innerHTML = `
        <div class="empty-state">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none">
            <path d="M7 18h2V6H7v12zm4 4h2V2h-2v20zm-8-8h2v-4H3v4zm12 4h2V6h-2v12zm4-8v4h2v-4h-2z" fill="currentColor"/>
          </svg>
          <p>No filters added yet</p>
          <p>Click "Add Filter" to get started</p>
        </div>
      `;
      return;
    }

    for (const filter of this.filters) {
      const row = document.createElement('div');
      row.className = `filter-row${filter.enabled ? '' : ' disabled'}${filter.id === this.selectedFilterId ? ' selected' : ''}`;
      row.dataset.filterId = filter.id;

      const typeConfig = FILTER_TYPE_CONFIG[filter.type] || FILTER_TYPE_CONFIG['PK'];

      row.innerHTML = `
        <span class="filter-col filter-col-toggle">
          <span class="filter-color-dot" style="background: ${filter.color}"></span>
          <button class="filter-toggle ${filter.enabled ? 'on' : ''}" data-action="toggle" title="Toggle filter"></button>
        </span>
        <span class="filter-col filter-col-type">
          <select class="select-styled select-sm filter-type-select">
            ${Object.entries(FILTER_TYPE_CONFIG).map(([key, cfg]) =>
              `<option value="${key}" ${key === filter.type ? 'selected' : ''}>${cfg.label}</option>`
            ).join('')}
          </select>
        </span>
        <span class="filter-col filter-col-freq">
          <div class="filter-input-group">
            <input type="number" class="filter-input filter-freq" value="${filter.frequency || ''}" min="1" max="24000" step="1" placeholder="Freq">
            <span class="unit">Hz</span>
          </div>
        </span>
        <span class="filter-col filter-col-gain">
          <div class="filter-input-group">
            <input type="number" class="filter-input filter-gain" value="${filter.gain !== null && filter.gain !== undefined ? filter.gain.toFixed(1) : ''}" min="-30" max="30" step="0.1" placeholder="Gain" ${typeConfig.hasGain ? '' : 'disabled'}>
            <span class="unit">dB</span>
          </div>
        </span>
        <span class="filter-col filter-col-q">
          <div class="filter-input-group">
            <input type="number" class="filter-input filter-q" value="${filter.q !== null && filter.q !== undefined ? filter.q.toFixed(3) : ''}" min="0.01" max="100" step="0.01" placeholder="Q" ${typeConfig.hasQ ? '' : 'disabled'}>
            <span class="unit">Q</span>
          </div>
        </span>
        <span class="filter-col filter-col-channel">
          <select class="select-styled select-sm filter-channel-select" title="Channel: all, Left, or Right">
            <option value="all" ${(filter.channel || 'all') === 'all' ? 'selected' : ''}>All</option>
            <option value="L" ${filter.channel === 'L' ? 'selected' : ''}>L</option>
            <option value="R" ${filter.channel === 'R' ? 'selected' : ''}>R</option>
          </select>
        </span>
        <span class="filter-col filter-col-actions">
          <button class="filter-action" data-action="duplicate" title="Duplicate filter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M7 7V5a2 2 0 012-2h9a2 2 0 012 2v9a2 2 0 01-2 2h-2v-2h2V5H9v2H7zm-3 4a2 2 0 012-2h9a2 2 0 012 2v8a2 2 0 01-2 2H6a2 2 0 01-2-2v-8zm2 0v8h9v-8H6z" fill="currentColor"/></svg>
          </button>
          <button class="filter-delete" data-action="delete" title="Remove filter">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" fill="currentColor"/></svg>
          </button>
        </span>
      `;

      // Events
      row.addEventListener('click', (e) => {
        if (!e.target.closest('[data-action]') && !e.target.closest('input') && !e.target.closest('select')) {
          this.selectFilter(filter.id);
        }
      });

      row.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input') || e.target.closest('select')) return;
        e.preventDefault();
        this.removeFilter(filter.id);
      });

      const toggle = row.querySelector('[data-action="toggle"]');
      toggle.addEventListener('click', () => {
        filter.enabled = !filter.enabled;
        toggle.classList.toggle('on', filter.enabled);
        row.classList.toggle('disabled', !filter.enabled);
        this._notify();
      });

      const typeSelect = row.querySelector('.filter-type-select');
      typeSelect.addEventListener('change', (e) => {
        filter.type = e.target.value;
        const cfg = FILTER_TYPE_CONFIG[filter.type];
        row.querySelector('.filter-gain').disabled = !cfg.hasGain;
        row.querySelector('.filter-q').disabled = !cfg.hasQ;
        if (!cfg.hasGain) filter.gain = null;
        if (!cfg.hasQ) filter.q = null;
        this._notify();
      });

      const freqInput = row.querySelector('.filter-freq');
      freqInput.addEventListener('input', (e) => {
        filter.frequency = parseFloat(e.target.value) || 0;
        this._notify();
      });

      const gainInput = row.querySelector('.filter-gain');
      gainInput.addEventListener('input', (e) => {
        filter.gain = parseFloat(e.target.value) || 0;
        this._notify();
      });

      const qInput = row.querySelector('.filter-q');
      qInput.addEventListener('input', (e) => {
        filter.q = parseFloat(e.target.value) || 0;
        this._notify();
      });

      const channelSelect = row.querySelector('.filter-channel-select');
      channelSelect.addEventListener('change', (e) => {
        filter.channel = e.target.value;
        this._notify();
      });

      const deleteBtn = row.querySelector('[data-action="delete"]');
      deleteBtn.addEventListener('click', () => {
        this.removeFilter(filter.id);
      });

      const duplicateBtn = row.querySelector('[data-action="duplicate"]');
      duplicateBtn.addEventListener('click', () => {
        this.duplicateFilter(filter.id);
      });

      this.container.appendChild(row);
    }
  }
}
