/**
 * Audio Preview Player
 * Real-time EQ preview using Web Audio API
 * Inspired by modernGraphTool's EqAudioPlayer
 */

export class AudioPlayer {
  constructor(container, getFilters, getPreamp) {
    this.container = container;
    this.getFilters = getFilters;   // () => filters[]
    this.getPreamp  = getPreamp;    // () => number (dB)

    this.audioCtx   = null;
    this.sourceNode = null;
    this.gainNode   = null;
    this.preampNode = null;
    this.filterNodes = [];
    this.analyserNode = null;
    this.onAnalyserChange = null;
    this.analyserCanvas = null;
    this.analyserCtx = null;
    this._animFrame  = null;
    this._analyserRunning = false;

    this.isPlaying  = false;
    this.eqEnabled  = true;
    this.volume     = 0.7;
    this.sourceType = 'pink';  // 'white' | 'pink' | 'tone' | 'file'
    this.toneFreq   = 1000;
    this.audioBuffer = null;   // for 'file' source
    this.audioElement = null;  // for file element source
    this.oscillatorNode = null;

    // Pink noise state
    this._pinkB = [0, 0, 0, 0, 0, 0, 0];

    this._render();
  }

  // ─── Build UI ──────────────────────────────────────────────
  _render() {
    this.container.innerHTML = `
      <div class="ap-wrap">
        <div class="ap-header">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
            <path d="M12 3v10.55A4 4 0 1014 17V7h4V3h-6z" fill="currentColor" opacity=".8"/>
          </svg>
          <span class="ap-title">EQ Preview</span>
          <label class="ap-eq-toggle" title="Enable/Disable EQ processing">
            <input type="checkbox" id="ap-eq-enabled" checked>
            <span class="ap-toggle-sw"></span>
            <span class="ap-toggle-label">EQ</span>
          </label>
        </div>

        <div class="ap-controls">
          <!-- Source selector -->
          <select id="ap-source-select" class="select-sm ap-select">
            <option value="pink" selected>Pink Noise</option>
            <option value="white">White Noise</option>
            <option value="tone">Tone</option>
            <option value="file">Audio File</option>
          </select>

          <!-- Tone frequency slider (hidden unless tone) -->
          <div id="ap-tone-row" class="ap-tone-row" style="display:none;">
            <span class="ap-label">Freq</span>
            <input type="range" id="ap-tone-freq" class="mini-slider" min="0" max="1" step="0.001" value="0.699">
            <span class="ap-label" id="ap-tone-label">1 kHz</span>
          </div>

          <!-- File input (hidden unless file) -->
          <div id="ap-file-row" class="ap-file-row" style="display:none;">
            <button class="btn-ghost ap-file-btn" id="ap-file-btn">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" fill="currentColor"/></svg>
              Load File
            </button>
            <span class="ap-filename" id="ap-filename">No file</span>
          </div>

          <!-- Transport -->
          <div class="ap-transport">
            <button class="ap-btn ap-play" id="ap-play" title="Play">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg>
            </button>
            <button class="ap-btn ap-stop" id="ap-stop" title="Stop" disabled>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="6" y="6" width="12" height="12" fill="currentColor"/></svg>
            </button>
          </div>

          <!-- Volume -->
          <div class="ap-vol-row">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" id="ap-vol-icon">
              <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0013 7.97v8.05A4.5 4.5 0 0016.5 12z" fill="currentColor"/>
            </svg>
            <input type="range" id="ap-volume" class="mini-slider ap-vol-slider" min="0" max="1" step="0.01" value="0.7">
          </div>
        </div>

        <!-- Spectrum Analyser -->
        <canvas id="ap-analyser" class="ap-analyser" height="48"></canvas>
      </div>
    `;

    this._bindEvents();
  }

  _bindEvents() {
    const $ = (id) => this.container.querySelector('#' + id);

    // Source select
    $('ap-source-select').addEventListener('change', (e) => {
      this.sourceType = e.target.value;
      $('ap-tone-row').style.display = this.sourceType === 'tone' ? 'flex' : 'none';
      $('ap-file-row').style.display = this.sourceType === 'file' ? 'flex' : 'none';
      if (this.isPlaying) { this.stop(); this.play(); }
    });

    // Tone freq slider (logarithmic 20–20000)
    $('ap-tone-freq').addEventListener('input', (e) => {
      const ratio = parseFloat(e.target.value);
      this.toneFreq = Math.round(Math.pow(10, 1.301 + ratio * 2.699)); // 20–20000
      $('ap-tone-label').textContent = this.toneFreq >= 1000
        ? (this.toneFreq / 1000).toFixed(this.toneFreq >= 10000 ? 0 : 1) + ' kHz'
        : this.toneFreq + ' Hz';
      if (this.oscillatorNode) this.oscillatorNode.frequency.value = this.toneFreq;
    });

    // File picker
    $('ap-file-btn').addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.onchange = async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        $('ap-filename').textContent = file.name;
        const buf = await file.arrayBuffer();
        if (!this.audioCtx) this._initAudioContext();
        this.audioBuffer = await this.audioCtx.decodeAudioData(buf);
        if (this.isPlaying) { this.stop(); this.play(); }
      };
      input.click();
    });

    // Play / Stop
    $('ap-play').addEventListener('click', () => {
      if (this.isPlaying) this.stop();
      else this.play();
    });
    $('ap-stop').addEventListener('click', () => this.stop());

    // Volume
    $('ap-volume').addEventListener('input', (e) => {
      this.volume = parseFloat(e.target.value);
      if (this.gainNode) this.gainNode.gain.value = this.volume;
    });

    // EQ toggle
    $('ap-eq-enabled').addEventListener('change', (e) => {
      this.eqEnabled = e.target.checked;
      if (this.isPlaying) this._rebuildChain();
    });

    // Analyser canvas
    this.analyserCanvas = this.container.querySelector('#ap-analyser');
    this.analyserCtx = this.analyserCanvas.getContext('2d');
  }

  // ─── Audio Context ─────────────────────────────────────────
  _initAudioContext() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  // ─── Build Web Audio graph ──────────────────────────────────
  _buildChain() {
    if (!this.audioCtx) return;

    // Analyser
    this.analyserNode = this.audioCtx.createAnalyser();
    this.analyserNode.fftSize = 2048;
    this.analyserNode.smoothingTimeConstant = 0.8;

    // Gain (volume)
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.volume;

    // Preamp
    this.preampNode = this.audioCtx.createGain();
    const preampDb = this.getPreamp ? this.getPreamp() : 0;
    this.preampNode.gain.value = Math.pow(10, preampDb / 20);

    if (this.eqEnabled) {
      // Build biquad filter chain from current filters
      const filters = this.getFilters ? this.getFilters() : [];
      this.filterNodes = filters
        .filter(f => f.enabled && f.frequency)
        .map(f => this._makeWebAudioFilter(f))
        .filter(Boolean);
    } else {
      this.filterNodes = [];
    }

    // Chain: source → [filter1 → filter2 → ...] → preamp → gain → analyser → dest
    const chain = [...this.filterNodes, this.preampNode, this.gainNode, this.analyserNode];
    for (let i = 0; i < chain.length - 1; i++) {
      chain[i].connect(chain[i + 1]);
    }
    this.analyserNode.connect(this.audioCtx.destination);
    this._chainInput = chain[0]; // connect source here
  }

  _makeWebAudioFilter(f) {
    const node = this.audioCtx.createBiquadFilter();
    switch (f.type) {
      case 'PK': case 'PEQ': case 'Modal':
        node.type = 'peaking'; break;
      case 'LP': case 'LPQ':
        node.type = 'lowpass'; break;
      case 'HP': case 'HPQ':
        node.type = 'highpass'; break;
      case 'BP':
        node.type = 'bandpass'; break;
      case 'LS': case 'LSC': case 'LS 6dB': case 'LS 12dB':
        node.type = 'lowshelf'; break;
      case 'HS': case 'HSC': case 'HS 6dB': case 'HS 12dB':
        node.type = 'highshelf'; break;
      case 'NO':
        node.type = 'notch'; break;
      case 'AP':
        node.type = 'allpass'; break;
      default:
        return null;
    }
    node.frequency.value = Math.max(10, Math.min(this.audioCtx.sampleRate / 2 - 1, f.frequency));
    if (f.gain != null) node.gain.value = f.gain;
    if (f.q != null) node.Q.value = f.q;
    return node;
  }

  _rebuildChain() {
    if (!this.isPlaying) return;
    this._disconnectSource();
    this._buildChain();
    this._connectSource();
    this._emitAnalyserChange();
  }

  _connectSource() {
    if (this.sourceNode && this._chainInput) {
      this.sourceNode.connect(this._chainInput);
    }
  }

  _disconnectSource() {
    try { if (this.sourceNode) this.sourceNode.disconnect(); } catch (_) {}
    try { if (this.filterNodes) this.filterNodes.forEach(n => { try { n.disconnect(); } catch(_){} }); } catch (_) {}
    try { if (this.preampNode) this.preampNode.disconnect(); } catch (_) {}
    try { if (this.gainNode) this.gainNode.disconnect(); } catch (_) {}
    try { if (this.analyserNode) this.analyserNode.disconnect(); } catch (_) {}
  }

  // ─── Create noise / tone source ────────────────────────────
  _createNoiseSource(type) {
    const bufferSize = this.audioCtx.sampleRate * 2; // 2 seconds looped
    const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
    const data = buffer.getChannelData(0);

    if (type === 'white') {
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    } else {
      // Paul Kellet's pink noise algorithm
      let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }

    const node = this.audioCtx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    return node;
  }

  _createToneSource() {
    const osc = this.audioCtx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = this.toneFreq;
    this.oscillatorNode = osc;
    return osc;
  }

  _createFileSource() {
    if (!this.audioBuffer) return null;
    const node = this.audioCtx.createBufferSource();
    node.buffer = this.audioBuffer;
    node.loop = true;
    return node;
  }

  // ─── Play / Stop ───────────────────────────────────────────
  play() {
    if (this.isPlaying) return;
    this._initAudioContext();
    if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

    if (this.sourceType === 'file' && !this.audioBuffer) {
      return; // no file loaded
    }

    let src;
    if (this.sourceType === 'tone') src = this._createToneSource();
    else if (this.sourceType === 'file') src = this._createFileSource();
    else src = this._createNoiseSource(this.sourceType);

    if (!src) return;
    this.sourceNode = src;

    this._buildChain();
    this._connectSource();
    src.start(0);

    this.isPlaying = true;
    this._updateTransportUI(true);
    this._emitAnalyserChange();
    this._startAnalyser();
  }

  stop() {
    if (!this.isPlaying) return;
    try {
      this.sourceNode?.stop();
      this.oscillatorNode = null;
    } catch (_) {}
    this._disconnectSource();
    this.sourceNode = null;
    this.isPlaying = false;
    this._updateTransportUI(false);
    this._emitAnalyserChange();
    this._stopAnalyser();
  }

  // Rebuild EQ chain while playing (called when filters change externally)
  refreshEQ() {
    if (this.isPlaying && this.eqEnabled) {
      this._rebuildChain();
    }
  }

  getAnalyserNode() {
    return this.isPlaying ? this.analyserNode : null;
  }

  _emitAnalyserChange() {
    if (this.onAnalyserChange) this.onAnalyserChange(this.getAnalyserNode());
  }

  // ─── Transport UI ──────────────────────────────────────────
  _updateTransportUI(playing) {
    const playBtn = this.container.querySelector('#ap-play');
    const stopBtn = this.container.querySelector('#ap-stop');
    if (!playBtn) return;

    if (playing) {
      playBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" fill="currentColor"/></svg>`;
      playBtn.title = 'Pause';
      stopBtn.disabled = false;
    } else {
      playBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg>`;
      playBtn.title = 'Play';
      stopBtn.disabled = true;
    }
  }

  // ─── Spectrum Analyser ─────────────────────────────────────
  _startAnalyser() {
    this._analyserRunning = true;
    this._drawAnalyser();
  }

  _stopAnalyser() {
    this._analyserRunning = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    // Clear canvas
    const c = this.analyserCanvas;
    if (c && this.analyserCtx) {
      this.analyserCtx.clearRect(0, 0, c.width, c.height);
    }
  }

  _drawAnalyser() {
    if (!this._analyserRunning) return;
    this._animFrame = requestAnimationFrame(() => this._drawAnalyser());

    const canvas = this.analyserCanvas;
    const ctx = this.analyserCtx;
    const analyser = this.analyserNode;
    if (!canvas || !ctx || !analyser) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }

    const bufLen = analyser.frequencyBinCount;
    const dataArr = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(dataArr);

    ctx.clearRect(0, 0, w, h);

    const barCount = 64;
    const barW = w / barCount - 1;

    for (let i = 0; i < barCount; i++) {
      const binIdx = Math.floor((i / barCount) * bufLen * 0.7);
      const val = dataArr[binIdx] / 255;
      const barH = val * h;

      // Gradient from cyan to purple
      const hue = 190 + (i / barCount) * 90;
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, 0.85)`;
      ctx.fillRect(i * (barW + 1), h - barH, barW, barH);
    }
  }

  destroy() {
    this.stop();
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
  }
}
