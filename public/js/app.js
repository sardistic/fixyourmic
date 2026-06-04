/* Main application — wires stream loading, analyzer, visualizer, and UI together */

const video = document.getElementById('stream-video');
const dashboard = document.getElementById('dashboard');
const statusBar = document.getElementById('status-bar');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');

// History: one sample per second, kept for 10 minutes
const MAX_HISTORY = 600;
const history = [];

// Target loudness — driven by the content-type dropdown
let TARGET_LUFS = -18;
document.getElementById('target-preset').addEventListener('change', e => {
  TARGET_LUFS = parseInt(e.target.value, 10);
});

let hls = null;
let audioCtx = null;
let analyzer = null;
let currentStreamLabel = '';
let lastMetrics = null;
let lastRecs = [];
let visualizer = null;
let animFrame = null;
let running = false;
let analysisStartTime = null;

// ── Tabs ────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ── Stream URL (via streamlink server-side) ──────────────────────────────────
document.getElementById('analyze-stream').addEventListener('click', () => {
  let raw = document.getElementById('stream-url-input').value.trim();
  if (!raw) return;
  // Accept bare channel name, twitch.tv/name, or full URL
  if (!/^https?:\/\//i.test(raw)) {
    raw = raw.replace(/^(www\.)?twitch\.tv\//i, '');
    raw = `https://www.twitch.tv/${raw.split('/')[0].split('?')[0]}`;
  }
  resolveAndLoad(raw);
});
document.getElementById('stream-url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('analyze-stream').click();
});

// ── Direct HLS URL (server-proxied for CORS) ─────────────────────────────────
document.getElementById('analyze-url').addEventListener('click', () => {
  const url = document.getElementById('url-input').value.trim();
  if (!url) return;
  loadHls(`/proxy?url=${encodeURIComponent(url)}`, url);
});
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('analyze-url').click();
});

document.getElementById('stop-btn').addEventListener('click', stopAnalysis);

// ── Resolve stream URL via streamlink then load ───────────────────────────────
async function resolveAndLoad(streamUrl) {
  setStatus('connecting', `Resolving stream...`);
  statusBar.classList.remove('hidden');

  try {
    const res = await fetch(`/api/stream?url=${encodeURIComponent(streamUrl)}`);
    const data = await res.json();
    if (data.error) {
      setStatus('error', data.error);
      return;
    }
    loadHls(data.url, streamUrl);
  } catch (err) {
    setStatus('error', `Network error: ${err.message}`);
  }
}

// ── HLS loading ───────────────────────────────────────────────────────────────
function loadHls(url, label) {
  stopAnalysis();
  setStatus('connecting', `Connecting to ${label}...`);

  if (!Hls.isSupported() && !video.canPlayType('application/vnd.apple.mpegurl')) {
    setStatus('error', 'HLS is not supported in this browser. Try Chrome or Firefox.');
    return;
  }

  if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      // Prefer audio-only variants to save bandwidth
    });
    hls.loadSource(url);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
      // Pick the lowest quality variant to reduce bandwidth (we only care about audio)
      const lowestLevel = data.levels.reduce((min, lv, i) => {
        return (lv.bitrate < data.levels[min].bitrate) ? i : min;
      }, 0);
      hls.currentLevel = lowestLevel;

      video.play().then(async () => {
        currentStreamLabel = label;
        setStatus('live', `Live: ${label}`);
        await initAudioAnalysis();
      }).catch(err => setStatus('error', `Playback error: ${err.message}`));
    });

    hls.on(Hls.Events.ERROR, (_, data) => {
      if (data.fatal) {
        setStatus('error', `Stream error: ${data.details}`);
        stopAnalysis();
      }
    });
  } else {
    // Safari native HLS
    video.src = url;
    video.play().then(async () => {
      setStatus('live', label);
      await initAudioAnalysis();
    }).catch(err => setStatus('error', err.message));
  }
}

// ── Audio analysis setup (from video element) ────────────────────────────────
async function initAudioAnalysis() {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // Must await resume — browser suspends new AudioContexts until user gesture unlocks them
  await audioCtx.resume();

  const source = audioCtx.createMediaElementSource(video);
  _startAnalyzerFromNode(source);
}

let recInterval = null;
let histInterval = null;
let listenerGain = null;

function _startAnalyzerFromNode(sourceNode) {
  // Listener output chain: source → listenerGain → destination
  // This is separate from the analysis chain so volume changes don't affect metrics.
  listenerGain = audioCtx.createGain();
  listenerGain.gain.value = document.getElementById('volume-slider').value / 100;
  sourceNode.connect(listenerGain);
  listenerGain.connect(audioCtx.destination);

  analyzer = new StreamAnalyzer(audioCtx);
  analyzer.connect(sourceNode);

  visualizer = new StreamVisualizer();
  visualizer.init(
    document.getElementById('spectrum-canvas'),
    document.getElementById('waveform-canvas'),
    document.getElementById('history-canvas'),
  );

  history.length = 0;
  document.getElementById('history-empty')?.classList.remove('hidden');
  dashboard.classList.remove('hidden');
  running = true;
  analysisStartTime = Date.now();

  // Sample metrics every second for the history chart
  histInterval = setInterval(() => {
    if (!running || !analyzer) return;
    const m = analyzer.getMetrics();
    history.push({
      t: Date.now(),
      lufs: m.lufsShortTerm,
      peak: m.peakHoldDB,
      rms: m.rmsDB,
    });
    if (history.length > MAX_HISTORY) history.shift();
  }, 1000);

  // Update recommendations every 5 seconds once enough data is collected
  recInterval = setInterval(() => {
    if (!running || !analyzer) return;
    const m = analyzer.getMetrics();
    if (m.hasEnoughData) {
      lastRecs = buildRecs(m);
      updateBroadcastScore(m);
      updateCorrections(m);
    }
  }, 3000);

  requestAnimationFrame(renderLoop);
}

// ── Render loop ───────────────────────────────────────────────────────────────
function renderLoop() {
  if (!running) return;

  const metrics = analyzer.getMetrics();
  lastMetrics = metrics;
  const freqData = analyzer.getFrequencyData();
  const timeData = analyzer.getTimeData();

  visualizer.drawSpectrum(freqData, audioCtx.sampleRate);
  visualizer.drawWaveform(timeData);
  visualizer.drawHistory(history);
  if (history.length >= 2) document.getElementById('history-empty')?.classList.add('hidden');

  updateMetricsUI(metrics);
  updateVuMeters(metrics.peakL, metrics.peakR);

  animFrame = requestAnimationFrame(renderLoop);
}

// ── UI update functions ───────────────────────────────────────────────────────
function updateMetricsUI(m) {
  // LUFS
  setText('lufs-integrated', fmt(m.lufsIntegrated, 1));
  setText('lufs-short', isFinite(m.lufsShortTerm) ? `${fmt(m.lufsShortTerm, 1)} LUFS` : '—');
  setText('lufs-moment', isFinite(m.lufsMomentary) ? `${fmt(m.lufsMomentary, 1)} LUFS` : '—');
  colorBigValue('lufs-integrated', lufsColor(m.lufsIntegrated));

  // Viewer impact line
  const vi = document.getElementById('viewer-impact');
  if (vi && isFinite(m.lufsIntegrated)) {
    const diff = m.lufsIntegrated - TARGET_LUFS;
    let msg, cls;
    if (diff > 5)       { msg = `${fmt(diff,1)} dB too loud for this content type`; cls = 'bad'; }
    else if (diff > 1)  { msg = `${fmt(diff,1)} dB above target — slightly loud`; cls = 'warn'; }
    else if (diff >= -2){ msg = `On target for ${document.getElementById('target-preset').selectedOptions[0]?.text.split('(')[0].trim() || 'selected content type'}`; cls = 'good'; }
    else if (diff >= -6){ msg = `${fmt(-diff,1)} dB below target — slightly quiet`; cls = 'warn'; }
    else                { msg = `${fmt(-diff,1)} dB below target — too quiet`; cls = 'bad'; }
    vi.textContent = msg;
    vi.className = `viewer-impact vi-${cls}`;
  }

  // LUFS gauge: map -40 to 0 dB → 0% to 100%
  const lufsToPercent = db => Math.max(0, Math.min(100, ((db + 40) / 40) * 100));
  const lufsPercent = isFinite(m.lufsIntegrated) ? lufsToPercent(m.lufsIntegrated) : 0;
  document.getElementById('lufs-fill').style.width = `${lufsPercent}%`;
  const needle = document.getElementById('lufs-needle');
  if (needle) needle.style.left = `${lufsPercent}%`;

  // Shift LUFS zone widths to track TARGET_LUFS
  const tooQuietEnd = lufsToPercent(TARGET_LUFS - 8);
  const lowEnd      = lufsToPercent(TARGET_LUFS - 3);
  const goodEnd     = lufsToPercent(TARGET_LUFS + 3);
  const highEnd     = lufsToPercent(TARGET_LUFS + 7);
  const zoneEls     = document.querySelectorAll('.lufs-zone');
  if (zoneEls.length === 5) {
    [tooQuietEnd, lowEnd - tooQuietEnd, goodEnd - lowEnd, highEnd - goodEnd, 100 - highEnd]
      .forEach((w, i) => zoneEls[i].style.flex = `0 0 ${Math.max(0, w)}%`);
  }

  // Peak
  const peakStr = isFinite(m.peakHoldDB) ? `${fmt(m.peakHoldDB, 1)}` : '—';
  setText('peak-value', peakStr);
  colorBigValue('peak-value', peakDB_color(m.peakHoldDB));

  setText('rms-value', isFinite(m.rmsDB) ? `${fmt(m.rmsDB, 1)} dBFS` : '—');
  setText('crest-value', m.crestFactor > 0 ? `${fmt(m.crestFactor, 1)} dB` : '—');

  // Clipping
  const clipBadge = document.getElementById('clip-badge');
  clipBadge.textContent = `${m.clipCount} clip${m.clipCount !== 1 ? 's' : ''}`;
  clipBadge.className = `clip-badge${m.clipCount > 0 ? ' clipping' : ''}`;

  // Dynamic range
  setText('dr-value', m.lra > 0 ? fmt(m.lra, 1) : '—');
  const drPercent = Math.max(0, Math.min(100, (m.lra / 20) * 100));
  document.getElementById('dr-fill').style.width = `${drPercent}%`;

  // Noise floor / headroom
  setText('noise-floor', isFinite(m.noiseFloor) ? `${fmt(m.noiseFloor, 1)} dBFS` : '—');
  if (m.headroom !== null) {
    const hw = m.headroom;
    const hwStr = hw > 0 ? `+${fmt(hw, 1)} LU` : `${fmt(hw, 1)} LU`;
    setText('headroom', hwStr);
  }

  // Frequency bands
  const bandMax = -20; const bandMin = -80;
  const bands = [
    ['sub', m.bands.sub],
    ['bass', m.bands.bass],
    ['lowmid', m.bands.lowMid],
    ['mid', m.bands.mid],
    ['presence', m.bands.presence],
    ['air', m.bands.air],
  ];
  for (const [id, db] of bands) {
    const pct = Math.max(0, Math.min(100, ((db - bandMin) / (bandMax - bandMin)) * 100));
    document.getElementById(`band-${id}`).style.height = `${pct}%`;
    document.getElementById(`band-${id}-db`).textContent = isFinite(db) ? `${Math.round(db)}` : '—';
  }

  // Platform comparison
  updatePlatformStatus(m.lufsIntegrated);
}

function updateVuMeters(peakL, peakR) {
  // Map 0–1 amplitude to bar height %: use dB scale
  const toPercent = v => {
    const db = v > 0 ? 20 * Math.log10(v) : -60;
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  };

  const leftBar = document.getElementById('vu-left');
  const rightBar = document.getElementById('vu-right');
  leftBar.style.height = `${toPercent(peakL)}%`;
  rightBar.style.height = `${toPercent(peakR)}%`;

  // Peak hold marks
  updateVuPeakHold('vu-peak-left', peakL);
  updateVuPeakHold('vu-peak-right', peakR);
}

const vuPeaks = { left: 0, right: 0, leftTimer: 0, rightTimer: 0 };
function updateVuPeakHold(id, peak) {
  const key = id.includes('left') ? 'left' : 'right';
  if (peak > vuPeaks[key]) {
    vuPeaks[key] = peak;
    vuPeaks[`${key}Timer`] = 90;
  } else {
    vuPeaks[`${key}Timer`]--;
    if (vuPeaks[`${key}Timer`] <= 0) vuPeaks[key] = Math.max(0, vuPeaks[key] - 0.01);
  }
  const db = vuPeaks[key] > 0 ? 20 * Math.log10(vuPeaks[key]) : -60;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const el = document.getElementById(id);
  el.style.bottom = `${pct}%`;
}

function updatePlatformStatus(lufs) {
  if (!isFinite(lufs)) return;

  const targets = [
    { id: 'plat-twitch-status',    target: -14, tol: 3, mode: 'max' },
    { id: 'plat-youtube-status',   target: -14, tol: 2, mode: 'target' },
    { id: 'plat-discord-status',   target: -16, tol: 2, mode: 'target' },
    { id: 'plat-broadcast-status', target: -23, tol: 3, mode: 'target' },
  ];

  for (const { id, target, tol, mode } of targets) {
    const el = document.getElementById(id);
    if (!el) continue;
    let badge, cls, label;

    if (mode === 'max') {
      if (lufs <= target) {
        cls = 'good'; label = `${fmt(lufs - target, 1)} LU`;
      } else {
        cls = 'bad'; label = `+${fmt(lufs - target, 1)} LU`;
      }
    } else {
      const diff = lufs - target;
      if (Math.abs(diff) <= tol) {
        cls = 'good'; label = diff >= 0 ? `+${fmt(diff, 1)}` : `${fmt(diff, 1)}`;
      } else if (lufs > target) {
        cls = 'warn'; label = `+${fmt(diff, 1)} LU`;
      } else {
        cls = 'warn'; label = `${fmt(diff, 1)} LU`;
      }
    }

    el.innerHTML = `<span class="status-badge ${cls}">${label}</span>`;
  }
}

// ── Recommendations engine ────────────────────────────────────────────────────
function buildRecs(m) {
  const recs = [];

  // Loudness
  if (isFinite(m.lufsIntegrated)) {
    const lufs = m.lufsIntegrated;
    if (lufs > -9) {
      recs.push({ type: 'bad', title: 'Audio is too loud', body: `At ${fmt(lufs, 1)} LUFS, platforms will aggressively reduce your stream. Target around −14 LUFS.` });
    } else if (lufs > TARGET_LUFS) {
      recs.push({ type: 'warn', title: 'Slightly above target', body: `${fmt(lufs, 1)} LUFS is ${fmt(lufs - TARGET_LUFS, 1)} LU above your content-type target. Reduce output by ~${fmt(lufs - TARGET_LUFS, 1)} LU.` });
    } else if (lufs >= -18) {
      recs.push({ type: 'good', title: 'Loudness on target', body: `${fmt(lufs, 1)} LUFS sits well within the −14 LUFS streaming sweet spot.` });
    } else if (lufs >= -23) {
      recs.push({ type: 'warn', title: 'Slightly quiet', body: `${fmt(lufs, 1)} LUFS is below typical streaming levels. Viewers may need to turn up their volume.` });
    } else {
      recs.push({ type: 'bad', title: 'Audio is too quiet', body: `${fmt(lufs, 1)} LUFS is very quiet. Most viewers will struggle without boosting their system volume significantly.` });
    }
  }

  // Clipping
  if (m.clipCount > 10) {
    recs.push({ type: 'bad', title: 'Clipping detected', body: `${m.clipCount} clipping events recorded. Viewers hear this as harsh digital distortion. Reduce your output gain or add a limiter.` });
  } else if (m.clipCount > 0) {
    recs.push({ type: 'warn', title: 'Minor clipping', body: `${m.clipCount} brief clip${m.clipCount > 1 ? 's' : ''} detected. Watch your peak levels — keep peak dBFS below −1 dBFS.` });
  } else if (isFinite(m.peakHoldDB) && m.peakHoldDB > -1) {
    recs.push({ type: 'warn', title: 'Peaks near 0 dBFS', body: `Peak at ${fmt(m.peakHoldDB, 1)} dBFS is very close to clipping. Any sudden loud moment will distort.` });
  } else if (isFinite(m.peakHoldDB) && m.peakHoldDB <= -1) {
    recs.push({ type: 'good', title: 'Peaks look clean', body: `Peak at ${fmt(m.peakHoldDB, 1)} dBFS — safe headroom, no clipping risk detected.` });
  }

  // Dynamic range
  if (m.lra > 0) {
    if (m.lra < 3) {
      recs.push({ type: 'warn', title: 'Very compressed', body: `Loudness range of ${fmt(m.lra, 1)} LU is extremely narrow. Heavy compression can cause listener fatigue over long streams.` });
    } else if (m.lra < 6) {
      recs.push({ type: 'info', title: 'Moderate compression', body: `${fmt(m.lra, 1)} LU range is typical for streaming. Not fatiguing for most viewers.` });
    } else if (m.lra <= 14) {
      recs.push({ type: 'good', title: 'Good dynamic range', body: `${fmt(m.lra, 1)} LU range sounds natural and uncompressed. Viewers won't need to constantly adjust volume.` });
    } else {
      recs.push({ type: 'warn', title: 'Very dynamic audio', body: `${fmt(m.lra, 1)} LU range means big swings between quiet and loud moments. Viewers may need to adjust volume frequently.` });
    }
  }

  // Frequency balance
  if (m.bands && m.bands.sub !== undefined) {
    const { sub, bass, lowMid, mid, presence, air } = m.bands;
    const lowEnd = (sub + bass) / 2;
    const highEnd = (presence + air) / 2;
    const diff = lowEnd - highEnd;

    if (diff > 12) {
      recs.push({ type: 'warn', title: 'Bottom-heavy mix', body: `Sub and bass are ${fmt(diff, 0)} dB louder than the high end. Audio may sound muddy or lacking clarity for viewers.` });
    } else if (diff < -12) {
      recs.push({ type: 'warn', title: 'Bright / harsh mix', body: `High frequencies are ${fmt(-diff, 0)} dB louder than bass. Can cause ear fatigue over extended watching.` });
    } else {
      recs.push({ type: 'good', title: 'Balanced frequency range', body: 'Low and high frequency energy are well-balanced — no obvious tonal issues detected.' });
    }

    // Voice clarity (mid range)
    const midAboveNoise = mid - (m.noiseFloor || -60);
    if (mid < lowEnd - 8) {
      recs.push({ type: 'warn', title: 'Scooped midrange', body: 'The 800 Hz–3 kHz vocal range is lower than the low end. Commentary and voice may sound thin or hard to follow.' });
    }

    // Presence / sibilance
    if (presence > mid + 6) {
      recs.push({ type: 'warn', title: 'High presence energy', body: `Strong 3–8 kHz energy (+${fmt(presence - mid, 0)} dB above mids). Check for sibilance (harsh "s" sounds) in voice, especially with condenser mics.` });
    }
  }

  // Noise floor (only flag if we have enough confident samples)
  if (isFinite(m.noiseFloor) && m.noiseFloorSamples?.length >= 30) {
    if (m.noiseFloor > -45) {
      recs.push({ type: 'bad', title: 'Audible noise floor', body: `Noise floor at ${fmt(m.noiseFloor, 1)} dBFS is clearly audible. Viewers hear persistent hiss or hum. A noise gate or noise suppressor is needed.` });
    } else if (m.noiseFloor > -50) {
      recs.push({ type: 'warn', title: 'Elevated noise floor', body: `Noise floor at ${fmt(m.noiseFloor, 1)} dBFS may be noticeable in quiet passages. A noise gate set around −45 dBFS threshold would help.` });
    }
    // -50 to -60: acceptable, no mention. Below -60: clean.
  }

  // Crest factor (compression indicator)
  if (m.crestFactor < 6) {
    recs.push({ type: 'warn', title: 'Low crest factor', body: `Crest factor of ${fmt(m.crestFactor, 1)} dB suggests heavy limiting or compression. Transients are likely squashed.` });
  }

  return recs;
}

function renderRecommendations(recs) {
  const container = document.getElementById('recommendations');
  if (!recs.length) {
    container.innerHTML = '<div class="rec-loading">Collecting data...</div>';
    return;
  }
  container.innerHTML = recs.map(r => `
    <div class="rec-item ${r.type}">
      <span class="rec-title ${r.type}">${r.title}</span>
      <span class="rec-body">${r.body}</span>
    </div>
  `).join('');
}

// ── Stop / cleanup ────────────────────────────────────────────────────────────
function stopAnalysis() {
  // Snapshot report data before teardown
  const hasData = history.length >= 10;
  let reportSnapshot = null;
  if (hasData) {
    const histCanvas = document.getElementById('history-canvas');
    reportSnapshot = {
      histImg: histCanvas.toDataURL('image/png'),
      history: [...history],
      metrics: lastMetrics,
      recs: lastRecs.length ? [...lastRecs] : (lastMetrics ? buildRecs(lastMetrics) : []),
      label: currentStreamLabel,
      date: new Date().toLocaleString(),
      startTime: analysisStartTime,
      targetLufs: TARGET_LUFS,
      contentType: document.getElementById('target-preset').selectedOptions[0]?.text.split('(')[0].trim() || 'Streaming',
    };
  }

  running = false;
  if (animFrame) cancelAnimationFrame(animFrame);
  if (recInterval) { clearInterval(recInterval); recInterval = null; }
  if (histInterval) { clearInterval(histInterval); histInterval = null; }
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.src = '';
  if (analyzer) { analyzer.disconnect(); analyzer = null; }
  if (audioCtx) { audioCtx.close(); audioCtx = null; }
  if (listenerGain) { listenerGain = null; }
  dashboard.classList.add('hidden');
  statusBar.classList.add('hidden');

  if (reportSnapshot) showReport(reportSnapshot);
}

// ── Volume / mute controls ────────────────────────────────────────────────────
const volumeSlider = document.getElementById('volume-slider');
const volumeDisplay = document.getElementById('volume-display');

volumeSlider.addEventListener('input', () => {
  const val = volumeSlider.value / 100;
  if (listenerGain) listenerGain.gain.value = val;
  volumeDisplay.textContent = `${volumeSlider.value}%`;
  // Sync mute icon state
  const muted = val === 0;
  document.getElementById('mute-icon-on').style.display = muted ? 'none' : '';
  document.getElementById('mute-icon-off').style.display = muted ? '' : 'none';
});

let _preMuteVolume = volumeSlider.value;
document.getElementById('mute-btn').addEventListener('click', () => {
  if (volumeSlider.value > 0) {
    _preMuteVolume = volumeSlider.value;
    volumeSlider.value = 0;
  } else {
    volumeSlider.value = _preMuteVolume;
  }
  volumeSlider.dispatchEvent(new Event('input'));
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  statusBar.classList.remove('hidden');
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

function fmt(n, decimals = 0) {
  if (!isFinite(n)) return '—';
  return n.toFixed(decimals);
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function colorBigValue(id, color) {
  const el = document.getElementById(id);
  if (el) el.style.color = color;
}

function lufsColor(lufs) {
  if (!isFinite(lufs)) return 'var(--text)';
  const diff = lufs - TARGET_LUFS;
  if (diff > 5)        return 'var(--red)';
  if (diff > 2)        return 'var(--orange)';
  if (diff >= -3)      return 'var(--green)';
  if (diff >= -8)      return 'var(--yellow)';
  return 'var(--text-muted)';
}

function peakDB_color(db) {
  if (!isFinite(db)) return 'var(--text)';
  if (db >= 0)   return 'var(--red)';
  if (db >= -1)  return 'var(--orange)';
  if (db >= -3)  return 'var(--yellow)';
  return 'var(--green)';
}

// ── Broadcast score ───────────────────────────────────────────────────────────
function updateBroadcastScore(m) {
  if (!isFinite(m.lufsIntegrated)) return;

  let score = 100;
  const issues = [];

  // Loudness vs content-type target
  const lufsDiff = m.lufsIntegrated - TARGET_LUFS;
  if (Math.abs(lufsDiff) > 1) {
    const penalty = Math.min(35, Math.abs(lufsDiff - (lufsDiff > 0 ? 1 : -1)) * 4);
    score -= penalty;
  }
  if (lufsDiff > 3)       issues.push({ cls: 'bad',  text: `${fmt(lufsDiff, 1)} LU above ${TARGET_LUFS} LUFS target` });
  else if (lufsDiff > 1)  issues.push({ cls: 'warn', text: `${fmt(lufsDiff, 1)} LU above content-type target` });
  else if (lufsDiff < -6) issues.push({ cls: 'warn', text: `${fmt(-lufsDiff, 1)} LU below target — quiet` });
  else                    issues.push({ cls: 'good', text: `Loudness on target (${TARGET_LUFS} LUFS)` });

  // Clipping
  if (m.clipCount > 0) {
    score -= Math.min(25, m.clipCount * 5);
    issues.push({ cls: 'bad', text: `${m.clipCount} digital clip${m.clipCount > 1 ? 's' : ''} — viewers hear distortion` });
  } else if (isFinite(m.peakHoldDB) && m.peakHoldDB >= -1) {
    score -= 10;
    issues.push({ cls: 'warn', text: `Peak at ${fmt(m.peakHoldDB, 1)} dBFS — ${fmt(-1 - m.peakHoldDB, 1)} dB from clipping` });
  } else {
    issues.push({ cls: 'good', text: 'Peak levels safe — no clipping' });
  }

  // Dynamic range
  if (m.lra > 0) {
    if (m.lra < 3)       { score -= 10; issues.push({ cls: 'warn', text: 'Over-compressed — flat, fatiguing sound' }); }
    else if (m.lra > 18) { score -= 8;  issues.push({ cls: 'warn', text: `${fmt(m.lra, 1)} LU range — inconsistent for viewers` }); }
    else                 { issues.push({ cls: 'good', text: `${fmt(m.lra, 1)} LU dynamic range — natural sounding` }); }
  }

  // Noise floor — only score when we have enough sustained quiet samples
  if (isFinite(m.noiseFloor) && m.noiseFloorSamples?.length >= 30) {
    if (m.noiseFloor > -45)      { score -= 15; issues.push({ cls: 'bad',  text: `Noise floor ${fmt(m.noiseFloor, 1)} dBFS — audible hiss` }); }
    else if (m.noiseFloor > -50) { score -= 5;  issues.push({ cls: 'warn', text: `Noise floor ${fmt(m.noiseFloor, 1)} dBFS — may be noticeable` }); }
    // -50 to -60: clean enough for streaming, no penalty
  }

  score = Math.max(0, Math.round(score));
  const grade = score >= 95 ? 'A+' : score >= 90 ? 'A' : score >= 85 ? 'B+' : score >= 80 ? 'B' : score >= 70 ? 'C' : score >= 60 ? 'D' : 'F';
  const gradeCls = score >= 85 ? 'grade-good' : score >= 70 ? 'grade-warn' : 'grade-bad';

  const gradeEl = document.getElementById('bb-grade');
  const numEl   = document.getElementById('bb-number');
  const fillEl  = document.getElementById('bb-fill');
  const issuesEl = document.getElementById('bb-issues');
  if (!gradeEl) return;

  gradeEl.textContent = grade;
  gradeEl.className = `bb-grade ${gradeCls}`;
  numEl.textContent = score;
  fillEl.style.width = `${score}%`;
  fillEl.className = `bb-bar-fill ${score >= 85 ? 'fill-good' : score >= 70 ? 'fill-warn' : 'fill-bad'}`;

  issuesEl.innerHTML = issues.map(i =>
    `<div class="bb-issue bb-${i.cls}"><span class="bb-dot"></span>${i.text}</div>`
  ).join('');
}

// ── Broadcast corrections ─────────────────────────────────────────────────────
function updateCorrections(m) {
  if (!isFinite(m.lufsIntegrated)) return;
  const corrs = [];

  // Loudness correction — the most important one
  const lufsDiff = m.lufsIntegrated - TARGET_LUFS;
  if (lufsDiff > 0.5) {
    corrs.push({
      priority: lufsDiff > 4 ? 'bad' : 'warn',
      icon: '↓',
      action: `Lower your output level by ${fmt(lufsDiff, 1)} dB`,
      why: `Your stream is ${fmt(lufsDiff, 1)} LU too loud. Viewers hear you louder than other content and Twitch's compressor will kick in.`,
      how: 'In OBS: Audio Mixer → right-click your source → Filters → Gain. Or lower your interface output knob.',
    });
  } else if (lufsDiff < -4) {
    corrs.push({
      priority: 'warn',
      icon: '↑',
      action: `Raise your output level by ${fmt(-lufsDiff, 1)} dB`,
      why: `Your stream is ${fmt(-lufsDiff, 1)} LU below target. Viewers need to turn up volume, then get startled by louder streams.`,
      how: 'In OBS: Filters → Gain. Or increase your mic/interface level.',
    });
  } else {
    corrs.push({
      priority: 'good',
      icon: '✓',
      action: `Loudness is on target (${TARGET_LUFS} LUFS)`,
      why: `At ${fmt(m.lufsIntegrated, 1)} LUFS, you're within ${fmt(Math.abs(lufsDiff), 1)} LU of the ${TARGET_LUFS} LUFS target — consistent with well-produced streaming content.`,
      how: null,
    });
  }

  // Clipping / peaks
  if (m.clipCount > 0) {
    const excess = Math.max(0, m.peakHoldDB);
    corrs.push({
      priority: 'bad',
      icon: '!',
      action: `Add a limiter at −1 dBFS${excess > 0 ? ` (or reduce gain by ${fmt(excess + 1, 1)} dB)` : ''}`,
      why: `${m.clipCount} digital clips detected. Viewers hear this as harsh crackling distortion — one of the most jarring listener experiences.`,
      how: 'In OBS: Filters → Limiter, threshold −1 dB. Or use a hardware limiter on your interface.',
    });
  } else if (isFinite(m.peakHoldDB) && m.peakHoldDB > -3) {
    const headroom = -1 - m.peakHoldDB;
    corrs.push({
      priority: 'warn',
      icon: '⚠',
      action: `Reduce gain by ${fmt(-headroom, 1)} dB or enable a −1 dBFS limiter`,
      why: `Peaks at ${fmt(m.peakHoldDB, 1)} dBFS leave only ${fmt(-headroom, 1)} dB before clipping. Any sudden loud sound will distort.`,
      how: 'OBS Filters → Limiter, or lower your output fader slightly.',
    });
  }

  // Compression / dynamics
  if (m.lra > 18) {
    corrs.push({
      priority: 'warn',
      icon: '↕',
      action: 'Add gentle compression — ratio 3:1, slow attack, moderate release',
      why: `Your audio swings ${fmt(m.lra, 1)} LU between quiet and loud. Viewers constantly adjust volume or miss quiet speech.`,
      how: 'OBS: Filters → Compressor. Threshold: −18 dB, Ratio: 3:1, Attack: 6 ms, Release: 60 ms.',
    });
  } else if (m.lra < 3 && m.crestFactor < 4) {
    corrs.push({
      priority: 'warn',
      icon: '↕',
      action: 'Reduce compression — raise threshold or lower ratio',
      why: `Crest factor is only ${fmt(m.crestFactor, 1)} dB — audio is heavily squashed. Sounds lifeless and causes listener fatigue.`,
      how: 'OBS: Filters → Compressor. Raise threshold by 6 dB, or reduce ratio to 2:1.',
    });
  }

  // Noise floor — only flag when we have 30+ sustained quiet samples (-55 dBFS threshold)
  if (isFinite(m.noiseFloor) && m.noiseFloorSamples?.length >= 30 && m.noiseFloor > -50) {
    corrs.push({
      priority: m.noiseFloor > -45 ? 'bad' : 'warn',
      icon: '~',
      action: 'Enable a noise gate (close threshold: −45 dBFS, open: −40 dBFS)',
      why: `Estimated noise floor at ${fmt(m.noiseFloor, 1)} dBFS${m.noiseFloor > -45 ? ' is clearly audible' : ' may be noticeable'} during pauses. Viewers hear room hiss, AC units, or keyboard noise between sentences.`,
      how: 'OBS: Filters → Noise Gate. Close: −40 dB, Open: −35 dB, Attack: 25 ms, Hold: 200 ms, Release: 150 ms.',
    });
  }

  // Frequency balance
  if (m.bands) {
    const lowEnd  = (m.bands.sub + m.bands.bass) / 2;
    const highEnd = (m.bands.presence + m.bands.air) / 2;
    const diff = lowEnd - highEnd;
    if (diff > 10) {
      corrs.push({
        priority: 'warn',
        icon: '♫',
        action: 'Apply high-pass filter at 80 Hz and cut 200–300 Hz by 3 dB',
        why: `Bass is ${fmt(diff, 0)} dB louder than highs. Voice sounds boomy and muddy — viewers strain to hear words clearly.`,
        how: 'OBS: Filters → VST (use ReaEQ or similar). High-pass at 80 Hz, notch at 250 Hz −3 dB.',
      });
    } else if (diff < -10) {
      corrs.push({
        priority: 'warn',
        icon: '♫',
        action: 'Cut 5–8 kHz by 3–4 dB (or use a de-esser)',
        why: `High frequencies are ${fmt(-diff, 0)} dB louder than the bass. Harsh sibilance ("s" and "t" sounds) causes ear fatigue over long streams.`,
        how: 'OBS: Filters → VST → de-esser plugin. Or cut 6 kHz with a parametric EQ.',
      });
    }
  }

  const el = document.getElementById('corrections-list');
  if (!el) return;

  if (!corrs.length) {
    el.innerHTML = '<div class="corr-placeholder">Audio looks good — no corrections needed.</div>';
    return;
  }

  el.innerHTML = corrs.map(c => `
    <div class="corr-item corr-${c.priority}">
      <div class="corr-icon">${c.icon}</div>
      <div class="corr-body">
        <div class="corr-action">${c.action}</div>
        <div class="corr-why">${c.why}</div>
        ${c.how ? `<div class="corr-how"><strong>How:</strong> ${c.how}</div>` : ''}
      </div>
    </div>`).join('');
}

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ── Report generation ─────────────────────────────────────────────────────────
function showReport(snap) {
  const { histImg, history: hist, metrics: m, recs, label, date, targetLufs = -18, contentType = 'Streaming' } = snap;
  const snapTarget = targetLufs;
  const duration = hist.length > 1 ? (hist[hist.length - 1].t - hist[0].t) / 1000 : 0;

  // Overall stats from full history
  const finLufs = hist.map(h => h.lufs).filter(isFinite);
  const finPeak = hist.map(h => h.peak).filter(isFinite);
  const finRms  = hist.map(h => h.rms).filter(isFinite);
  const avgLufs = finLufs.length ? finLufs.reduce((a, b) => a + b) / finLufs.length : null;
  const minLufs = finLufs.length ? Math.min(...finLufs) : null;
  const maxLufs = finLufs.length ? Math.max(...finLufs) : null;
  const maxPeak = finPeak.length ? Math.max(...finPeak) : null;
  const avgRms  = finRms.length  ? finRms.reduce((a, b) => a + b) / finRms.length : null;

  // 60-second segments
  const BUCKET = 60;
  const segments = [];
  for (let i = 0; i < hist.length; i += BUCKET) {
    const bucket = hist.slice(i, i + BUCKET);
    const bl = bucket.map(h => h.lufs).filter(isFinite);
    const bp = bucket.map(h => h.peak).filter(isFinite);
    const br = bucket.map(h => h.rms).filter(isFinite);
    if (!bl.length) continue;
    const al = bl.reduce((a, b) => a + b) / bl.length;
    const mp = Math.max(...bp);
    const ar = br.length ? br.reduce((a, b) => a + b) / br.length : null;
    const offset = (bucket[0].t - hist[0].t) / 1000;
    let flag = '';
    let flagClass = '';
    if (mp >= -1)                  { flag = 'Clipping risk';  flagClass = 'seg-bad'; }
    else if (al > snapTarget + 5)  { flag = 'Very loud';      flagClass = 'seg-bad'; }
    else if (al > snapTarget + 2)  { flag = 'Loud';           flagClass = 'seg-warn'; }
    else if (al < snapTarget - 10) { flag = 'Very quiet';     flagClass = 'seg-info'; }
    else if (al < snapTarget - 5)  { flag = 'Quiet';          flagClass = 'seg-info'; }
    segments.push({ time: fmtTime(offset), avgLufs: al, maxPeak: mp, avgRms: ar, flag, flagClass });
  }

  // Platform compliance
  const platforms = [
    { name: 'Twitch',    target: -14, mode: 'max',    desc: '−14 LUFS max' },
    { name: 'YouTube',   target: -14, mode: 'target', desc: '−14 LUFS target' },
    { name: 'Discord',   target: -16, mode: 'target', desc: '−16 LUFS recommended' },
    { name: 'Broadcast', target: -23, mode: 'target', desc: '−23 LUFS (EBU R128)' },
  ];
  const platRows = platforms.map(p => {
    if (avgLufs === null) return `<tr><td>${p.name}</td><td>${p.desc}</td><td class="seg-info">No data</td><td></td></tr>`;
    const diff = avgLufs - p.target;
    const pass = p.mode === 'max' ? avgLufs <= p.target : Math.abs(diff) <= 4;
    const cls = pass ? 'seg-good' : (Math.abs(diff) <= 6 ? 'seg-warn' : 'seg-bad');
    const result = pass ? 'Pass' : (diff > 0 ? `+${fmt(diff, 1)} LU` : `${fmt(diff, 1)} LU`);
    return `<tr><td>${p.name}</td><td>${p.desc}</td><td class="${cls}">${pass ? '✓' : '✗'} ${result}</td></tr>`;
  }).join('');

  // Segment table rows
  const segRows = segments.map(s => `
    <tr class="${s.flagClass}">
      <td>${s.time}</td>
      <td>${fmt(s.avgLufs, 1)}</td>
      <td>${fmt(s.maxPeak, 1)}</td>
      <td>${s.avgRms !== null ? fmt(s.avgRms, 1) : '—'}</td>
      <td>${s.flag || '—'}</td>
    </tr>`).join('');

  // Recommendation items
  const recHTML = recs.length
    ? recs.map(r => `<div class="rep-rec ${r.type}"><strong>${r.title}</strong><br>${r.body}</div>`).join('')
    : '<div class="rep-rec info">Not enough data collected for recommendations.</div>';

  const el = document.getElementById('report');
  el.innerHTML = `
    <div class="rep-toolbar no-print">
      <button class="btn-primary" onclick="document.getElementById('report').classList.add('hidden'); document.querySelector('.input-section').classList.remove('hidden');">
        ← New Analysis
      </button>
      <button class="btn-export" onclick="window.print()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
        Export PDF
      </button>
    </div>

    <div class="rep-header">
      <div class="rep-header-row">
        <div>
          <div class="rep-title">StreamAudio — Analysis Report</div>
          <div class="rep-meta">
            <span>${label}</span>
            <span>${date}</span>
            <span>Duration: ${fmtTime(duration)}</span>
            <span>Target: ${snapTarget} LUFS (${contentType})</span>
          </div>
        </div>
        ${avgLufs !== null ? (() => {
          let sc = 100;
          const ld = Math.abs(avgLufs - snapTarget);
          if (ld > 1) sc -= Math.min(35, (ld - 1) * 4);
          if (m && m.clipCount > 0) sc -= Math.min(25, m.clipCount * 5);
          if (m && m.lra < 3) sc -= 10; else if (m && m.lra > 18) sc -= 8;
          sc = Math.max(0, Math.round(sc));
          const g = sc>=95?'A+':sc>=90?'A':sc>=85?'B+':sc>=80?'B':sc>=70?'C':sc>=60?'D':'F';
          const gc = sc>=85?'#22c55e':sc>=70?'#f59e0b':'#ef4444';
          return `<div class="rep-score-badge" style="border-color:${gc}"><span style="color:${gc};font-size:1.8rem;font-weight:800">${g}</span><br><span style="font-size:0.7rem;color:#666">${sc}/100</span></div>`;
        })() : ''}
      </div>
    </div>

    <div class="rep-section">
      <div class="rep-section-title">Key Metrics</div>
      <div class="rep-stats">
        <div class="rep-stat">
          <div class="rep-stat-val ${avgLufs !== null && Math.abs(avgLufs - snapTarget) <= 3 ? 'good' : avgLufs !== null && Math.abs(avgLufs - snapTarget) <= 6 ? 'warn' : ''}">${avgLufs !== null ? fmt(avgLufs, 1) : '—'}</div>
          <div class="rep-stat-label">Avg LUFS</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val">${minLufs !== null ? fmt(minLufs, 1) : '—'}</div>
          <div class="rep-stat-label">Min LUFS</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val">${maxLufs !== null ? fmt(maxLufs, 1) : '—'}</div>
          <div class="rep-stat-label">Max LUFS</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val ${maxPeak !== null && maxPeak >= -1 ? 'bad' : maxPeak !== null && maxPeak >= -3 ? 'warn' : 'good'}">${maxPeak !== null ? fmt(maxPeak, 1) : '—'}</div>
          <div class="rep-stat-label">Peak dBFS</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val">${avgRms !== null ? fmt(avgRms, 1) : '—'}</div>
          <div class="rep-stat-label">Avg RMS</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val ${m && m.clipCount > 0 ? 'bad' : 'good'}">${m ? m.clipCount : '—'}</div>
          <div class="rep-stat-label">Clip Events</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val">${m && m.lra > 0 ? fmt(m.lra, 1) : '—'}</div>
          <div class="rep-stat-label">Dyn Range (LU)</div>
        </div>
        <div class="rep-stat">
          <div class="rep-stat-val">${m && isFinite(m.noiseFloor) ? fmt(m.noiseFloor, 1) : '—'}</div>
          <div class="rep-stat-label">Noise Floor</div>
        </div>
      </div>
    </div>

    <div class="rep-section">
      <div class="rep-section-title">Level History</div>
      <div class="rep-chart-legend">
        <span style="color:#ef4444">■</span> Peak &nbsp;
        <span style="color:#7c3aed">■</span> LUFS (Short-term) &nbsp;
        <span style="color:#06b6d4">■</span> RMS
      </div>
      <img src="${histImg}" class="rep-chart-img" alt="Level history chart">
    </div>

    <div class="rep-section">
      <div class="rep-section-title">Time Segments (60s intervals)</div>
      <table class="rep-table">
        <thead><tr><th>Time</th><th>Avg LUFS</th><th>Peak dBFS</th><th>Avg RMS</th><th>Notes</th></tr></thead>
        <tbody>${segRows || '<tr><td colspan="5" style="text-align:center;color:#666">Not enough data</td></tr>'}</tbody>
      </table>
    </div>

    <div class="rep-section">
      <div class="rep-section-title">Platform Compliance</div>
      <table class="rep-table">
        <thead><tr><th>Platform</th><th>Target</th><th>Result</th></tr></thead>
        <tbody>${platRows}</tbody>
      </table>
    </div>

    <div class="rep-section">
      <div class="rep-section-title">Recommendations</div>
      <div class="rep-recs">${recHTML}</div>
    </div>
  `;

  el.classList.remove('hidden');
  document.querySelector('.input-section').classList.add('hidden');
}
