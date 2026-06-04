/**
 * StreamVisualizer — canvas drawing for spectrum analyzer and waveform.
 */
class StreamVisualizer {
  constructor() {
    this.spectrumCanvas = null;
    this.waveformCanvas = null;
    this._spectrumCtx = null;
    this._waveCtx = null;

    // Frequency band color regions (Hz boundaries for spectrum coloring)
    this.bandColors = [
      { freq: 60,    color: '#7c3aed' }, // sub — purple
      { freq: 250,   color: '#3b82f6' }, // bass — blue
      { freq: 800,   color: '#06b6d4' }, // low-mid — cyan
      { freq: 3000,  color: '#22c55e' }, // mid — green
      { freq: 8000,  color: '#f59e0b' }, // presence — amber
      { freq: 20000, color: '#ec4899' }, // air — pink
    ];

    // Smoothed spectrum display buffer
    this._smoothSpectrum = null;
    this._peakSpectrum = null;
    this._peakDecay = null;
  }

  init(spectrumCanvas, waveformCanvas, historyCanvas) {
    this.spectrumCanvas = spectrumCanvas;
    this.waveformCanvas = waveformCanvas;
    this.historyCanvas = historyCanvas;
    this._spectrumCtx = spectrumCanvas.getContext('2d');
    this._waveCtx = waveformCanvas.getContext('2d');
    this._histCtx = historyCanvas.getContext('2d');
    this._resizeObserver = new ResizeObserver(() => this._resizeCanvases());
    this._resizeObserver.observe(spectrumCanvas);
    this._resizeObserver.observe(waveformCanvas);
    this._resizeObserver.observe(historyCanvas);
    this._resizeCanvases();
  }

  _resizeCanvases() {
    for (const canvas of [this.spectrumCanvas, this.waveformCanvas, this.historyCanvas].filter(Boolean)) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width * window.devicePixelRatio;
        canvas.height = rect.height * window.devicePixelRatio;
      }
    }
  }

  drawSpectrum(freqData, sampleRate) {
    const canvas = this.spectrumCanvas;
    const ctx = this._spectrumCtx;
    if (!ctx || canvas.width === 0) return;

    const W = canvas.width;
    const H = canvas.height;
    const bins = freqData.length;
    const nyquist = sampleRate / 2;

    // Init smoothing/peak buffers on first run or size change
    if (!this._smoothSpectrum || this._smoothSpectrum.length !== bins) {
      this._smoothSpectrum = new Float32Array(bins).fill(-100);
      this._peakSpectrum = new Float32Array(bins).fill(-100);
      this._peakDecay = new Float32Array(bins).fill(0);
    }

    // Smooth spectrum: fast attack, slow decay
    for (let i = 0; i < bins; i++) {
      const v = freqData[i];
      if (v > this._smoothSpectrum[i]) {
        this._smoothSpectrum[i] = v * 0.7 + this._smoothSpectrum[i] * 0.3;
      } else {
        this._smoothSpectrum[i] = v * 0.05 + this._smoothSpectrum[i] * 0.95;
      }
      // Peak hold + decay
      if (v > this._peakSpectrum[i]) {
        this._peakSpectrum[i] = v;
        this._peakDecay[i] = 60; // hold ~1s at 60fps
      } else {
        this._peakDecay[i]--;
        if (this._peakDecay[i] <= 0) {
          this._peakSpectrum[i] -= 0.3;
        }
      }
    }

    ctx.clearRect(0, 0, W, H);

    // Background grid
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const dbLevels = [-80, -60, -48, -36, -24, -12, -6, -3];
    for (const db of dbLevels) {
      // Map db (from -90 to 0) → y position
      const y = H - ((db + 90) / 90) * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    // Frequency band separator lines
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    const sepFreqs = [60, 250, 800, 3000, 8000];
    for (const f of sepFreqs) {
      const x = this._freqToX(f, nyquist, bins, W);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    // Draw spectrum bars
    const barWidth = Math.max(1, W / bins * 1.5);

    for (let i = 1; i < bins; i++) {
      const freq = (i / bins) * nyquist;
      // Logarithmic x mapping
      const x = this._freqToX(freq, nyquist, bins, W);
      const prevX = this._freqToX(((i - 1) / bins) * nyquist, nyquist, bins, W);
      const w = Math.max(1, x - prevX);

      const db = this._smoothSpectrum[i];
      // Map dB to height: -90 dB = 0, 0 dB = H
      const h = Math.max(0, ((db + 90) / 90) * H);

      ctx.fillStyle = this._bandColor(freq);
      ctx.fillRect(prevX, H - h, w, h);
    }

    // Peak hold line
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let started = false;
    for (let i = 1; i < bins; i++) {
      const freq = (i / bins) * nyquist;
      const x = this._freqToX(freq, nyquist, bins, W);
      const db = this._peakSpectrum[i];
      const y = H - Math.max(0, ((db + 90) / 90) * H);
      if (!started) { ctx.moveTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // dB labels on the right
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${9 * window.devicePixelRatio}px monospace`;
    ctx.textAlign = 'right';
    for (const db of [-60, -36, -12]) {
      const y = H - ((db + 90) / 90) * H;
      ctx.fillText(`${db}`, W - 4, y - 2);
    }
  }

  _freqToX(freq, nyquist, bins, W) {
    // Log scale: map 20 Hz – nyquist onto 0 – W
    const logMin = Math.log10(20);
    const logMax = Math.log10(nyquist);
    return ((Math.log10(Math.max(20, freq)) - logMin) / (logMax - logMin)) * W;
  }

  _bandColor(freq) {
    if (freq < 60)    return 'rgba(124,58,237,0.85)';
    if (freq < 250)   return 'rgba(59,130,246,0.85)';
    if (freq < 800)   return 'rgba(6,182,212,0.85)';
    if (freq < 3000)  return 'rgba(34,197,94,0.85)';
    if (freq < 8000)  return 'rgba(245,158,11,0.85)';
    return 'rgba(236,72,153,0.85)';
  }

  drawWaveform(timeData) {
    const canvas = this.waveformCanvas;
    const ctx = this._waveCtx;
    if (!ctx || canvas.width === 0) return;

    const W = canvas.width;
    const H = canvas.height;
    const mid = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(W, mid);
    ctx.stroke();

    // Waveform
    const step = Math.ceil(timeData.length / W);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(124,58,237,0.9)';
    ctx.lineWidth = 1.5;

    for (let x = 0; x < W; x++) {
      let min = 1, max = -1;
      for (let j = 0; j < step; j++) {
        const idx = x * step + j;
        if (idx < timeData.length) {
          if (timeData[idx] < min) min = timeData[idx];
          if (timeData[idx] > max) max = timeData[idx];
        }
      }
      const yMax = mid - max * mid * 0.9;
      const yMin = mid - min * mid * 0.9;
      if (x === 0) ctx.moveTo(x, yMax);
      else {
        ctx.lineTo(x, yMax);
        if (Math.abs(yMax - yMin) > 1) ctx.lineTo(x, yMin);
      }
    }
    ctx.stroke();

    // Fill
    ctx.strokeStyle = 'rgba(124,58,237,0.0)';
    ctx.fillStyle = 'rgba(124,58,237,0.12)';
    ctx.fill();
  }

  drawHistory(history) {
    const canvas = this.historyCanvas;
    const ctx = this._histCtx;
    if (!ctx || canvas.width === 0) return;

    const W = canvas.width;
    const H = canvas.height;
    const dpr = window.devicePixelRatio;

    ctx.clearRect(0, 0, W, H);

    // Y range: -48 dB to 0 dB
    const DB_MIN = -48;
    const DB_MAX = 0;
    const toY = db => H - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * H;

    // Grid lines + labels
    const gridLevels = [0, -3, -6, -14, -18, -23, -36, -48];
    const labeledLevels = new Set([-3, -14, -23, -48]);
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'left';
    for (const db of gridLevels) {
      const y = toY(db);
      // Highlight platform targets
      const isTarget = db === -14 || db === -23;
      ctx.strokeStyle = isTarget ? 'rgba(124,58,237,0.25)' : 'rgba(255,255,255,0.06)';
      ctx.lineWidth = isTarget ? 1.5 : 1;
      ctx.setLineDash(isTarget ? [4, 4] : []);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      ctx.setLineDash([]);
      if (labeledLevels.has(db)) {
        ctx.fillStyle = isTarget ? 'rgba(124,58,237,0.7)' : 'rgba(255,255,255,0.22)';
        const label = db === -14 ? '-14 (Twitch)' : db === -23 ? '-23 (Broadcast)' : `${db}`;
        ctx.fillText(label, 4, y - 3);
      }
    }

    if (history.length < 2) return;

    // Draw a shaded band between RMS and Peak
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = (i / (history.length - 1)) * W;
      const pk = history[i].peak;
      if (!isFinite(pk)) continue;
      if (i === 0) ctx.moveTo(x, toY(pk));
      else ctx.lineTo(x, toY(pk));
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const x = (i / (history.length - 1)) * W;
      const rms = history[i].rms;
      if (!isFinite(rms)) continue;
      ctx.lineTo(x, toY(rms));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(239,68,68,0.07)';
    ctx.fill();

    // Draw the three lines: Peak, Short-term LUFS, RMS
    const lines = [
      { key: 'peak', color: 'rgba(239,68,68,0.85)',   width: 1.5, label: 'Peak' },
      { key: 'lufs', color: 'rgba(124,58,237,0.95)',  width: 2,   label: 'LUFS' },
      { key: 'rms',  color: 'rgba(6,182,212,0.75)',   width: 1.5, label: 'RMS'  },
    ];

    for (const line of lines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width * dpr;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < history.length; i++) {
        const v = history[i][line.key];
        if (!isFinite(v)) { started = false; continue; }
        const x = (i / (history.length - 1)) * W;
        const y = toY(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Time axis labels
    const elapsed = (history[history.length - 1].t - history[0].t) / 1000;
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'right';
    ctx.fillText('now', W - 4, H - 4);
    ctx.textAlign = 'left';
    if (elapsed > 10) ctx.fillText(`${Math.round(elapsed)}s ago`, 4, H - 4);

    // Legend (top right)
    ctx.textAlign = 'right';
    let lx = W - 4;
    for (const line of [...lines].reverse()) {
      ctx.fillStyle = line.color;
      const tw = ctx.measureText(line.label).width + 12;
      ctx.fillText(line.label, lx, 14 * dpr);
      lx -= tw;
    }
  }
}
