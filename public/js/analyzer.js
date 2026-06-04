/**
 * StreamAnalyzer — wraps Web Audio API to produce real-time audio metrics.
 *
 * Metrics produced:
 *  - Peak dBFS (with 2s hold)
 *  - RMS dBFS
 *  - Integrated LUFS (ITU-R BS.1770-4 approximation via K-weighting)
 *  - Short-term LUFS (3s window)
 *  - Momentary LUFS (400ms window)
 *  - Dynamic range / loudness range (LRA)
 *  - Crest factor
 *  - Noise floor estimate
 *  - Clipping event count
 *  - Per-channel (L/R) peak for VU meters
 *  - 6-band frequency balance
 */
class StreamAnalyzer {
  constructor(audioCtx) {
    this.ctx = audioCtx;

    // Main analyser (high resolution for spectrum + waveform)
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.8;

    // Per-channel splitter for L/R VU meters
    this.splitter = audioCtx.createChannelSplitter(2);
    this.mergerNode = audioCtx.createChannelMerger(2);
    this.analyserL = audioCtx.createAnalyser();
    this.analyserL.fftSize = 2048;
    this.analyserR = audioCtx.createAnalyser();
    this.analyserR.fftSize = 2048;

    // K-weighting chain for LUFS (ITU-R BS.1770)
    // Stage 1: high-shelf pre-filter (+4 dB at ~1500 Hz)
    this.kShelf = audioCtx.createBiquadFilter();
    this.kShelf.type = 'highshelf';
    this.kShelf.frequency.value = 1500;
    this.kShelf.gain.value = 4.0;
    // Stage 2: high-pass filter (12 dB/oct at ~38 Hz)
    this.kHiPass = audioCtx.createBiquadFilter();
    this.kHiPass.type = 'highpass';
    this.kHiPass.frequency.value = 38.135;
    this.kHiPass.Q.value = 0.5003;
    // Analyser on the K-weighted signal
    this.kAnalyser = audioCtx.createAnalyser();
    this.kAnalyser.fftSize = 2048;
    this.kAnalyser.smoothingTimeConstant = 0;

    // Accumulated LUFS measurement blocks (400 ms each)
    this.lufsBlocks = [];
    this.shortTermBlocks = [];
    this.momentaryBlock = -Infinity;
    this._lufsInterval = null;

    // Peak hold
    this.peakHold = -Infinity;
    this.peakHoldSamples = 0;
    this.PEAK_HOLD_FRAMES = 120; // ~2 seconds at 60fps

    // Clipping
    this.clipCount = 0;
    this.CLIP_THRESHOLD = 0.999; // ~-0.009 dBFS

    // Noise floor estimation
    this.noiseFloorSamples = [];
    this.noiseFloor = -60;

    // History for loudness range (LRA)
    this.lraHistory = [];
  }

  connect(sourceNode) {
    // Main chain: source → main analyser → destination
    sourceNode.connect(this.analyser);

    // L/R split for VU meters
    sourceNode.connect(this.splitter);
    this.splitter.connect(this.analyserL, 0);
    this.splitter.connect(this.analyserR, 1);

    // K-weighted chain for LUFS: source → kShelf → kHiPass → kAnalyser
    sourceNode.connect(this.kShelf);
    this.kShelf.connect(this.kHiPass);
    this.kHiPass.connect(this.kAnalyser);

    // Audio is routed to the destination externally (via a GainNode)
    // so the listener volume can be adjusted without affecting analysis.
    this._startLufsAccumulator();
  }

  disconnect() {
    clearInterval(this._lufsInterval);
  }

  // Accumulates 400 ms K-weighted blocks for LUFS calculation
  _startLufsAccumulator() {
    const BLOCK_MS = 400;
    const MAX_INTEGRATED_BLOCKS = 9999;
    const SHORT_TERM_BLOCKS = Math.ceil(3000 / BLOCK_MS); // 3 s
    const MOMENTARY_BLOCKS = 1; // 400 ms

    this._lufsInterval = setInterval(() => {
      const td = new Float32Array(this.kAnalyser.fftSize);
      this.kAnalyser.getFloatTimeDomainData(td);

      const ms = td.reduce((s, v) => s + v * v, 0) / td.length;
      // BS.1770 block loudness: -0.691 + 10*log10(ms)
      const blockLoudness = ms > 0 ? -0.691 + 10 * Math.log10(ms) : -Infinity;

      this.momentaryBlock = blockLoudness;

      this.shortTermBlocks.push(blockLoudness);
      if (this.shortTermBlocks.length > SHORT_TERM_BLOCKS) this.shortTermBlocks.shift();

      this.lufsBlocks.push(blockLoudness);
      if (this.lufsBlocks.length > MAX_INTEGRATED_BLOCKS) this.lufsBlocks.shift();

      // Track for LRA
      if (isFinite(blockLoudness)) {
        this.lraHistory.push(blockLoudness);
        if (this.lraHistory.length > 750) this.lraHistory.shift(); // ~5 min
      }
    }, BLOCK_MS);
  }

  _gatedMean(blocks) {
    const finite = blocks.filter(b => isFinite(b) && b > -70);
    if (!finite.length) return -Infinity;

    const ungatedMean = finite.reduce((s, b) => s + Math.pow(10, b / 10), 0) / finite.length;
    const ungatedLUFS = -0.691 + 10 * Math.log10(ungatedMean);

    // Relative gate: discard blocks more than 10 LU below ungated average
    const threshold = ungatedLUFS - 10;
    const gated = finite.filter(b => b >= threshold);
    if (!gated.length) return -Infinity;

    const gatedMean = gated.reduce((s, b) => s + Math.pow(10, b / 10), 0) / gated.length;
    return -0.691 + 10 * Math.log10(gatedMean);
  }

  _loudnessRange(blocks) {
    const finite = blocks.filter(b => isFinite(b) && b > -70).sort((a, b) => a - b);
    if (finite.length < 4) return 0;
    // LRA: difference between 95th and 10th percentile of gated blocks
    const lo = finite[Math.floor(finite.length * 0.1)];
    const hi = finite[Math.floor(finite.length * 0.95)];
    return Math.max(0, hi - lo);
  }

  getMetrics() {
    const td = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(td);

    // Peak & RMS
    let peak = 0;
    let sumSq = 0;
    let clipThisFrame = false;
    for (let i = 0; i < td.length; i++) {
      const abs = Math.abs(td[i]);
      if (abs > peak) peak = abs;
      sumSq += abs * abs;
      if (abs >= this.CLIP_THRESHOLD) clipThisFrame = true;
    }
    if (clipThisFrame) this.clipCount++;

    const rms = Math.sqrt(sumSq / td.length);
    const peakDB = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    const rmsDB = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    const crestFactor = rms > 0 ? 20 * Math.log10(peak / rms) : 0;

    // Peak hold
    if (peakDB > this.peakHold) {
      this.peakHold = peakDB;
      this.peakHoldSamples = this.PEAK_HOLD_FRAMES;
    } else {
      this.peakHoldSamples--;
      if (this.peakHoldSamples <= 0) {
        this.peakHold = Math.max(this.peakHold - 0.5, peakDB);
      }
    }

    // Per-channel peaks for VU
    const tdL = new Float32Array(this.analyserL.fftSize);
    const tdR = new Float32Array(this.analyserR.fftSize);
    this.analyserL.getFloatTimeDomainData(tdL);
    this.analyserR.getFloatTimeDomainData(tdR);
    const peakL = Math.max(...tdL.map(Math.abs));
    const peakR = Math.max(...tdR.map(Math.abs));

    // Noise floor: only sample during genuinely quiet moments (< -55 dBFS).
    // Using -40 was too loose — it caught brief pauses in music/game audio.
    // Track the 10th percentile (near-minimum) of quiet samples, not the average,
    // because noise floor is defined as the floor, not the mean of quiet periods.
    // Require 30+ samples (~0.5s at 60fps) before trusting the estimate.
    if (rmsDB < -55) {
      this.noiseFloorSamples.push(rmsDB);
      if (this.noiseFloorSamples.length > 300) this.noiseFloorSamples.shift();
      if (this.noiseFloorSamples.length >= 30) {
        const sorted = [...this.noiseFloorSamples].sort((a, b) => a - b);
        // 10th percentile — representative floor, not skewed by the quietest outlier
        this.noiseFloor = sorted[Math.floor(sorted.length * 0.1)];
      }
    }

    // LUFS
    const lufsIntegrated = this._gatedMean(this.lufsBlocks);
    const lufsShortTerm = this._gatedMean(this.shortTermBlocks);
    const lufsMomentary = this.momentaryBlock;
    const lra = this._loudnessRange(this.lraHistory);

    // Headroom (from integrated LUFS)
    const headroom = isFinite(lufsIntegrated) ? -14 - lufsIntegrated : null;

    // Frequency bands
    const fd = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(fd);
    const bands = this._computeBands(fd, this.ctx.sampleRate);

    return {
      peakDB,
      peakHoldDB: this.peakHold,
      rmsDB,
      crestFactor,
      peakL,
      peakR,
      lufsIntegrated,
      lufsShortTerm,
      lufsMomentary,
      lra,
      headroom,
      noiseFloor: this.noiseFloor,
      noiseFloorSamples: this.noiseFloorSamples,
      clipCount: this.clipCount,
      bands,
      hasEnoughData: this.lufsBlocks.length >= 5,
    };
  }

  // Returns average dBFS for each frequency band
  _computeBands(freqData, sampleRate) {
    const binHz = sampleRate / 2 / freqData.length;
    const ranges = {
      sub:      [20, 60],
      bass:     [60, 250],
      lowMid:   [250, 800],
      mid:      [800, 3000],
      presence: [3000, 8000],
      air:      [8000, 20000],
    };

    const result = {};
    for (const [name, [lo, hi]] of Object.entries(ranges)) {
      const start = Math.floor(lo / binHz);
      const end = Math.min(Math.ceil(hi / binHz), freqData.length - 1);
      let sum = 0; let count = 0;
      for (let i = start; i <= end; i++) {
        if (freqData[i] > -128) { sum += freqData[i]; count++; }
      }
      result[name] = count > 0 ? sum / count : -80;
    }
    return result;
  }

  getFrequencyData() {
    const fd = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(fd);
    return fd;
  }

  getTimeData() {
    const td = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(td);
    return td;
  }
}
