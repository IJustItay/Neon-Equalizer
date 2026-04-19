/**
 * Graphic EQ Panel Component
 * Rigid, APO-friendly slider editor with numeric entry and curve-preserving
 * band changes.
 */

const ISO_BANDS = {
  10: [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
  15: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000],
  31: [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
       630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
       10000, 12500, 16000, 20000]
};

const GAIN_MIN = -15;
const GAIN_MAX = 15;
const GAIN_STEP = 0.5;
const FREQ_MIN = 10;
const FREQ_MAX = 24000;
const NUMBER_PATTERN = /[-+]?(?:\d+[\.,]?\d*|[\.,]\d+)(?:[eE][-+]?\d+)?/g;

export class GraphicEQ {
  constructor(container, onChange) {
    this.container = container;
    this.onChange = onChange;
    this.bands = [];
    this.bandCount = 15;
    this.enabled = true;

    this.init(15, false, false);
  }

  init(bandCount, preserveCurve = true, emit = true) {
    const nextCount = Number(bandCount) || 15;
    const freqs = ISO_BANDS[nextCount] || ISO_BANDS[15];
    const previous = preserveCurve ? this.bands : [];
    this.bandCount = nextCount;
    this.bands = freqs.map(f => ({
      frequency: f,
      gain: previous.length ? this._roundGain(this._interpolateGain(previous, f)) : 0
    }));
    this._render();
    if (emit) this._notify();
  }

  setFrequencies(frequencies, preserveCurve = true, emit = true) {
    const freqs = this._normalizeFrequencies(frequencies);
    if (!freqs.length) return false;

    const previous = preserveCurve ? this.bands : [];
    this.bands = freqs.map(f => ({
      frequency: f,
      gain: previous.length ? this._roundGain(this._interpolateGain(previous, f)) : 0
    }));
    this.bandCount = this._detectBandCount(this.bands) || 'custom';
    this._render();
    if (emit) this._notify();
    return true;
  }

  setBands(bands, enabled = this.enabled) {
    if (Array.isArray(bands) && bands.length > 0) {
      this.bands = bands
        .map(b => ({
          frequency: this._roundFrequency(Number(b.frequency)),
          gain: this._clampGain(Number(b.gain) || 0)
        }))
        .filter(b => Number.isFinite(b.frequency) && b.frequency > 0)
        .sort((a, b) => a.frequency - b.frequency);
      this.bandCount = this._detectBandCount(this.bands) || 'custom';
    }
    this.enabled = enabled !== false;
    this._render();
    this._notify();
  }

  setEnabled(enabled) {
    this.enabled = !!enabled;
    this.container.classList.toggle('geq-disabled', !this.enabled);
    this._notify();
  }

  getBands() {
    return this.bands.map(b => ({ ...b }));
  }

  getConfig() {
    return {
      bands: this.getBands(),
      bandCount: this.bandCount,
      enabled: this.enabled
    };
  }

  reset() {
    this.bands.forEach(b => b.gain = 0);
    this._render();
    this._notify();
  }

  addBand(frequency = 1000) {
    const freq = this._roundFrequency(frequency);
    if (!Number.isFinite(freq)) return false;
    this.bands.push({ frequency: freq, gain: this._roundGain(this._interpolateGain(this.bands, freq)) });
    this.bands.sort((a, b) => a.frequency - b.frequency);
    this.bandCount = this._detectBandCount(this.bands) || 'custom';
    this._render();
    this._notify();
    return true;
  }

  removeBand(index) {
    if (this.bands.length <= 1 || index < 0 || index >= this.bands.length) return false;
    this.bands.splice(index, 1);
    this.bandCount = this._detectBandCount(this.bands) || 'custom';
    this._render();
    this._notify();
    return true;
  }

  duplicateBand(index) {
    if (index < 0 || index >= this.bands.length) return false;
    const source = this.bands[index];
    const frequency = this._findDuplicateFrequency(source.frequency);
    this.bands.push({ frequency, gain: source.gain });
    this.bands.sort((a, b) => a.frequency - b.frequency);
    this.bandCount = this._detectBandCount(this.bands) || 'custom';
    this._render();
    this._notify();
    return true;
  }

  updateBandFrequency(index, frequency) {
    const freq = this._roundFrequency(frequency);
    if (!Number.isFinite(freq) || index < 0 || index >= this.bands.length) return false;
    this.bands[index].frequency = freq;
    this.bands.sort((a, b) => a.frequency - b.frequency);
    this.bandCount = this._detectBandCount(this.bands) || 'custom';
    this._render();
    this._notify();
    return true;
  }

  invert() {
    this.bands = this.bands.map(b => ({ ...b, gain: this._roundGain(-b.gain) }));
    this._render();
    this._notify();
  }

  normalize() {
    if (!this.bands.length) return;
    const maxGain = Math.max(...this.bands.map(b => b.gain));
    if (Math.abs(maxGain) < 0.001) return;
    this.bands = this.bands.map(b => ({ ...b, gain: this._roundGain(b.gain - maxGain) }));
    this._render();
    this._notify();
  }

  smooth() {
    if (this.bands.length < 3) return;
    const next = this.bands.map((band, i) => {
      const prev = this.bands[Math.max(0, i - 1)].gain;
      const curr = band.gain;
      const following = this.bands[Math.min(this.bands.length - 1, i + 1)].gain;
      return {
        ...band,
        gain: this._roundGain((prev + curr * 2 + following) / 4)
      };
    });
    this.bands = next;
    this._render();
    this._notify();
  }

  importFromText(text) {
    const bands = GraphicEQ.parseFrequencyResponse(text);
    if (!bands.length) return 0;
    this.setBands(bands, true);
    return bands.length;
  }

  toCSV() {
    return this.bands
      .map(b => `${formatNumber(b.frequency)}\t${formatNumber(b.gain)}`)
      .join('\n') + '\n';
  }

  static parseFrequencyResponse(text) {
    const bands = [];
    const lines = String(text || '').split(/\r?\n/);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('#')) continue;

      const values = trimmed.match(NUMBER_PATTERN);
      if (!values || values.length < 2) continue;

      for (let i = 0; i + 1 < values.length; i += 2) {
        const frequency = parseImportedNumber(values[i]);
        const gain = parseImportedNumber(values[i + 1]);
        if (Number.isFinite(frequency) && frequency > 0 && Number.isFinite(gain)) {
          bands.push({ frequency, gain });
        }
      }
    }

    return bands.sort((a, b) => a.frequency - b.frequency);
  }

  static parseFrequencyList(text) {
    return String(text || '')
      .match(NUMBER_PATTERN)
      ?.map(parseImportedNumber)
      .filter(f => Number.isFinite(f) && f > 0) || [];
  }

  _notify() {
    if (this.onChange) this.onChange(this.getConfig());
  }

  _formatFreq(f) {
    if (f >= 1000) return (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k';
    return Number.isInteger(f) ? String(f) : String(f);
  }

  _clampGain(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(GAIN_MIN, Math.min(GAIN_MAX, value));
  }

  _roundFrequency(value) {
    if (!Number.isFinite(value)) return null;
    const clamped = Math.max(FREQ_MIN, Math.min(FREQ_MAX, value));
    return Number(clamped.toFixed(clamped < 100 ? 2 : clamped < 1000 ? 1 : 0));
  }

  _roundGain(value) {
    return Math.round(this._clampGain(value) / GAIN_STEP) * GAIN_STEP;
  }

  _normalizeFrequencies(frequencies) {
    const seen = new Set();
    return (frequencies || [])
      .map(f => this._roundFrequency(Number(f)))
      .filter(f => Number.isFinite(f))
      .sort((a, b) => a - b)
      .filter(f => {
        const key = f.toFixed(2);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  _findDuplicateFrequency(frequency) {
    const used = new Set(this.bands.map(b => this._roundFrequency(b.frequency).toFixed(2)));
    const base = Math.max(FREQ_MIN, Math.min(FREQ_MAX, Number(frequency) || 1000));
    for (const ratio of [1.03, 0.97, 1.06, 0.94, 1.1, 0.9]) {
      const candidate = this._roundFrequency(base * ratio);
      if (Number.isFinite(candidate) && !used.has(candidate.toFixed(2))) return candidate;
    }
    for (let offset = 1; offset <= 1000; offset++) {
      const candidate = this._roundFrequency(base + offset);
      if (Number.isFinite(candidate) && !used.has(candidate.toFixed(2))) return candidate;
    }
    return this._roundFrequency(base);
  }


  _detectBandCount(bands) {
    for (const [count, freqs] of Object.entries(ISO_BANDS)) {
      if (bands.length !== freqs.length) continue;
      const matches = freqs.every((freq, i) => Math.abs(freq - bands[i].frequency) < 0.01);
      if (matches) return Number(count);
    }
    return null;
  }

  _interpolateGain(bands, freq) {
    const sorted = bands.slice().sort((a, b) => a.frequency - b.frequency);
    if (!sorted.length) return 0;
    if (freq <= sorted[0].frequency) return sorted[0].gain;
    const last = sorted.length - 1;
    if (freq >= sorted[last].frequency) return sorted[last].gain;

    for (let i = 0; i < last; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (freq < a.frequency || freq > b.frequency) continue;
      const ratio = Math.log(freq / a.frequency) / Math.log(b.frequency / a.frequency);
      return a.gain + (b.gain - a.gain) * Math.max(0, Math.min(1, ratio));
    }
    return 0;
  }

  _render() {
    this.container.innerHTML = '';
    this.container.classList.toggle('geq-disabled', !this.enabled);

    const ruler = document.createElement('div');
    ruler.className = 'geq-ruler';
    ruler.innerHTML = `
      <span>+15</span>
      <span>+7.5</span>
      <span>0</span>
      <span>-7.5</span>
      <span>-15</span>
    `;
    this.container.appendChild(ruler);

    const bandsWrap = document.createElement('div');
    bandsWrap.className = 'geq-bands';

    for (let i = 0; i < this.bands.length; i++) {
      const band = this.bands[i];
      const bandEl = document.createElement('div');
      bandEl.className = 'geq-band';

      const pos = ((GAIN_MAX - band.gain) / (GAIN_MAX - GAIN_MIN)) * 100;
      const fillTop = Math.min(50, pos);
      const fillHeight = Math.abs(pos - 50);
      const fillClass = band.gain < 0 ? 'negative' : 'positive';

      bandEl.innerHTML = `
        <input type="number" class="geq-frequency-input" min="${FREQ_MIN}" max="${FREQ_MAX}" step="0.1" value="${formatNumber(band.frequency)}" aria-label="Band ${i + 1} frequency in Hz">
        <input type="number" class="geq-value-input" min="${GAIN_MIN}" max="${GAIN_MAX}" step="${GAIN_STEP}" value="${band.gain.toFixed(1)}" aria-label="${this._formatFreq(band.frequency)} Hz gain">
        <div class="geq-slider-track">
          <div class="geq-zero-line"></div>
          <div class="geq-slider-fill ${fillClass}" style="top:${fillTop}%;height:${fillHeight}%"></div>
          <input type="range" class="geq-slider-input" min="${GAIN_MIN}" max="${GAIN_MAX}" step="${GAIN_STEP}" value="${band.gain}" data-index="${i}" aria-label="${this._formatFreq(band.frequency)} Hz slider">
        </div>
        <div class="geq-band-footer">
          <span class="geq-freq">${this._formatFreq(band.frequency)}</span>
          <span class="geq-band-actions">
            <button type="button" class="geq-duplicate-band" title="Duplicate ${this._formatFreq(band.frequency)} Hz band" aria-label="Duplicate ${this._formatFreq(band.frequency)} Hz band">+</button>
            <button type="button" class="geq-remove-band" title="Remove ${this._formatFreq(band.frequency)} Hz band" aria-label="Remove ${this._formatFreq(band.frequency)} Hz band">x</button>
          </span>
        </div>
      `;

      const slider = bandEl.querySelector('.geq-slider-input');
      const input = bandEl.querySelector('.geq-value-input');
      const freqInput = bandEl.querySelector('.geq-frequency-input');
      const duplicateBtn = bandEl.querySelector('.geq-duplicate-band');
      const removeBtn = bandEl.querySelector('.geq-remove-band');
      const fill = bandEl.querySelector('.geq-slider-fill');

      const updateVisual = (value) => {
        const val = this._roundGain(value);
        band.gain = val;
        slider.value = val;
        input.value = val.toFixed(1);
        const nextPos = ((GAIN_MAX - val) / (GAIN_MAX - GAIN_MIN)) * 100;
        fill.style.top = `${Math.min(50, nextPos)}%`;
        fill.style.height = `${Math.abs(nextPos - 50)}%`;
        fill.className = `geq-slider-fill ${val < 0 ? 'negative' : 'positive'}`;
      };

      slider.addEventListener('input', (e) => {
        updateVisual(parseFloat(e.target.value));
        this._notify();
      });

      input.addEventListener('change', (e) => {
        updateVisual(parseFloat(e.target.value));
        this._notify();
      });

      freqInput.addEventListener('change', (e) => {
        this.updateBandFrequency(i, parseFloat(e.target.value));
      });

      slider.addEventListener('dblclick', () => {
        updateVisual(0);
        this._notify();
      });

      bandEl.addEventListener('contextmenu', (e) => {
        if (e.target.closest('input')) return;
        e.preventDefault();
        this.removeBand(i);
      });

      duplicateBtn.addEventListener('click', () => {
        this.duplicateBand(i);
      });

      removeBtn.addEventListener('click', () => {
        this.removeBand(i);
      });

      bandsWrap.appendChild(bandEl);
    }

    this.container.appendChild(bandsWrap);
  }
}

function formatNumber(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(3).replace(/\.?0+$/, '');
}

function parseImportedNumber(value) {
  const normalized = String(value).replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : null;
}
