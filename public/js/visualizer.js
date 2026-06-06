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

    // Subtle frequency regions so the band legend maps to the plot.
    const bandRegions = [
      { from: 20,   to: 60,    color: 'rgba(124,58,237,0.08)' },
      { from: 60,   to: 250,   color: 'rgba(59,130,246,0.075)' },
      { from: 250,  to: 800,   color: 'rgba(6,182,212,0.07)' },
      { from: 800,  to: 3000,  color: 'rgba(34,197,94,0.065)' },
      { from: 3000, to: 8000,  color: 'rgba(245,158,11,0.07)' },
      { from: 8000, to: 20000, color: 'rgba(236,72,153,0.07)' },
    ];
    for (const band of bandRegions) {
      const x1 = this._freqToX(band.from, nyquist, bins, W);
      const x2 = this._freqToX(Math.min(band.to, nyquist), nyquist, bins, W);
      ctx.fillStyle = band.color;
      ctx.fillRect(x1, 0, Math.max(0, x2 - x1), H);
    }

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

  drawHistory(history, targetLufs = -18) {
    const canvas = this.historyCanvas;
    const ctx = this._histCtx;
    if (!ctx || canvas.width === 0) return;

    const W = canvas.width;
    const H = canvas.height;
    const dpr = window.devicePixelRatio;
    const pad = {
      left: 54 * dpr,
      right: 88 * dpr,
      top: 18 * dpr,
      bottom: 26 * dpr,
    };
    const plotW = Math.max(1, W - pad.left - pad.right);
    const plotH = Math.max(1, H - pad.top - pad.bottom);

    ctx.clearRect(0, 0, W, H);

    // Y range: -48 dB to 0 dB
    const DB_MIN = -48;
    const DB_MAX = 0;
    const toY = db => pad.top + plotH - ((Math.max(DB_MIN, Math.min(DB_MAX, db)) - DB_MIN) / (DB_MAX - DB_MIN)) * plotH;
    const toX = t => {
      if (history.length < 2) return pad.left;
      const start = history[0].t;
      const end = history[history.length - 1].t;
      const span = Math.max(1, end - start);
      return pad.left + ((t - start) / span) * plotW;
    };

    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.018)';
    ctx.fillRect(pad.left, pad.top, plotW, plotH);

    // Background bands: near-clipping danger and content target range.
    ctx.fillStyle = 'rgba(239,68,68,0.10)';
    ctx.fillRect(pad.left, pad.top, plotW, Math.max(0, toY(-3) - pad.top));

    const targetTop = toY(targetLufs + 3);
    const targetBottom = toY(targetLufs - 3);
    ctx.fillStyle = 'rgba(34,197,94,0.08)';
    ctx.fillRect(pad.left, targetTop, plotW, targetBottom - targetTop);

    // Y grid lines + labels
    const gridLevels = [0, -3, -6, -12, -14, -18, -23, -30, -36, -48];
    const labeledLevels = new Set([0, -3, -14, -18, -23, -36, -48]);
    ctx.font = `${10 * dpr}px monospace`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const db of gridLevels) {
      const y = toY(db);
      const isReference = db === -14 || db === -18 || db === -23;
      ctx.strokeStyle = isReference ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.07)';
      ctx.lineWidth = isReference ? 1.25 * dpr : 1 * dpr;
      ctx.setLineDash(isReference ? [5 * dpr, 5 * dpr] : []);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(pad.left + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      if (labeledLevels.has(db)) {
        ctx.fillStyle = db === -3 ? 'rgba(239,68,68,0.70)' : 'rgba(255,255,255,0.42)';
        ctx.fillText(`${db}`, pad.left - 8 * dpr, y);
      }
    }

    // Axis border
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1 * dpr;
    ctx.strokeRect(pad.left, pad.top, plotW, plotH);

    if (history.length < 2) {
      ctx.restore();
      return;
    }

    // Time grid uses actual timestamps, so pauses or dropped samples do not bend the scale.
    const elapsed = (history[history.length - 1].t - history[0].t) / 1000;
    const interval = elapsed > 300 ? 120 : elapsed > 120 ? 60 : elapsed > 60 ? 30 : elapsed > 30 ? 15 : 10;
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let sec = interval; sec < elapsed; sec += interval) {
      const t = history[0].t + sec * 1000;
      const x = toX(t);
      ctx.strokeStyle = 'rgba(255,255,255,0.055)';
      ctx.beginPath();
      ctx.moveTo(x, pad.top);
      ctx.lineTo(x, pad.top + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.fillText(formatHistoryTime(sec), x, pad.top + plotH + 6 * dpr);
    }

    // Draw a soft envelope between RMS and Peak to show density without overpowering LUFS.
    ctx.beginPath();
    for (let i = 0; i < history.length; i++) {
      const x = toX(history[i].t);
      const pk = history[i].peak;
      if (!isFinite(pk)) continue;
      if (i === 0) ctx.moveTo(x, toY(pk));
      else ctx.lineTo(x, toY(pk));
    }
    for (let i = history.length - 1; i >= 0; i--) {
      const x = toX(history[i].t);
      const rms = history[i].rms;
      if (!isFinite(rms)) continue;
      ctx.lineTo(x, toY(rms));
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(6,182,212,0.055)';
    ctx.fill();

    // Draw the three lines: Peak, Short-term LUFS, RMS
    const lines = [
      { key: 'peak', color: 'rgba(239,68,68,0.82)',  width: 1.35, label: 'Peak' },
      { key: 'rms',  color: 'rgba(6,182,212,0.68)',  width: 1.35, label: 'RMS'  },
      { key: 'lufs', color: 'rgba(168,85,247,0.98)', width: 2.6,  label: 'LUFS' },
    ];

    for (const line of lines) {
      ctx.strokeStyle = line.color;
      ctx.lineWidth = line.width * dpr;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < history.length; i++) {
        const v = history[i][line.key];
        if (!isFinite(v)) { started = false; continue; }
        const x = toX(history[i].t);
        const y = toY(v);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Current-value tags on the right edge.
    const latest = history[history.length - 1];
    const tags = [];
    for (const line of lines) {
      const value = latest[line.key];
      if (!isFinite(value)) continue;
      tags.push({
        line,
        value,
        y: Math.max(pad.top + 10 * dpr, Math.min(pad.top + plotH - 10 * dpr, toY(value))),
      });
    }
    tags.sort((a, b) => a.y - b.y);
    for (let i = 1; i < tags.length; i++) {
      tags[i].y = Math.max(tags[i].y, tags[i - 1].y + 18 * dpr);
    }
    for (let i = tags.length - 2; i >= 0; i--) {
      tags[i].y = Math.min(tags[i].y, tags[i + 1].y - 18 * dpr);
    }
    for (const tag of tags) {
      const y = Math.max(pad.top + 10 * dpr, Math.min(pad.top + plotH - 10 * dpr, tag.y));
      const label = `${tag.line.label} ${tag.value.toFixed(1)}`;
      ctx.font = `${9 * dpr}px monospace`;
      const tw = ctx.measureText(label).width;
      const x = pad.left + plotW + 7 * dpr;
      ctx.fillStyle = 'rgba(15,23,42,0.88)';
      ctx.strokeStyle = tag.line.color;
      ctx.lineWidth = 1 * dpr;
      roundRect(ctx, x, y - 8 * dpr, tw + 8 * dpr, 16 * dpr, 4 * dpr);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = tag.line.color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 4 * dpr, y);
    }

    // Axis labels and endpoints.
    ctx.fillStyle = 'rgba(255,255,255,0.34)';
    ctx.font = `${9 * dpr}px monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('dBFS / LUFS', pad.left, 4 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText('now', pad.left + plotW, pad.top + plotH + 6 * dpr);
    ctx.textAlign = 'left';
    ctx.fillText(`${formatHistoryTime(elapsed)} ago`, pad.left, pad.top + plotH + 6 * dpr);

    ctx.restore();
  }
}

function formatHistoryTime(seconds) {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}:${String(s).padStart(2, '0')}` : `${m}m`;
  }
  return `${Math.round(seconds)}s`;
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}
