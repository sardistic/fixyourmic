/* Optional hardware-aware advice.
 *
 * Does NOT change what we detect. It re-targets the `how` line of each
 * correction to the streamer's actual gear, and suppresses advice that
 * doesn't apply to their mic (e.g. condenser sibilance tips on a dynamic).
 *
 * Correction `issue` keys used below:
 *   loud | quiet | clip | peak | dyn-wide | dyn-narrow | noise | muddy | harsh
 *
 * Everything degrades gracefully: unknown gear or unknown issue → null,
 * and callers keep the generic OBS text.
 */

// ── Mic catalog ───────────────────────────────────────────────────────────────
// `type` drives suppression. `hot` = needs lots of clean gain (Cloudlifter turf).
const MICS = {
  generic:   { label: 'Not sure / generic',  type: null },
  dynamic:   { label: 'Generic dynamic',     type: 'dynamic' },
  condenser: { label: 'Generic condenser',   type: 'condenser' },
  sm7b:      { label: 'Shure SM7B',          type: 'dynamic',   hot: true,  tips: {
    muddy: 'The SM7B has a bass-rolloff switch on the back — flip it on to tame proximity boom.',
    quiet: 'The SM7B is a quiet mic. If your preamp gain is near max, add a Cloudlifter/FetHead (+25 dB clean).',
  }},
  podmic:    { label: 'Rode PodMic',         type: 'dynamic',   hot: true,  tips: {
    muddy: 'PodMic proximity effect is strong — back off 2–3 inches before EQ-ing out the boom.',
  }},
  yeti:      { label: 'Blue Yeti',           type: 'condenser', tips: {
    noise: 'The Yeti picks up the whole room. Switch to Cardioid, move closer, and gate hard.',
    harsh: 'Condenser + close talking exaggerates "s". De-ess at 6–8 kHz and pull back ~15 cm.',
  }},
  at2020:    { label: 'Audio-Technica AT2020', type: 'condenser' },
  wave:      { label: 'Elgato Wave / USB',   type: 'condenser', tips: {
    clip: 'Wave has onboard Clipguard, but also lower the input gain in Wave Link before touching software.',
  }},
  nt1:       { label: 'Rode NT1',            type: 'condenser', tips: {
    harsh: 'The NT1 is bright and detailed — de-ess at 6–8 kHz rather than a broad treble cut.',
  }},
  procaster: { label: 'Rode Procaster',      type: 'dynamic',   hot: true, tips: {
    quiet: 'The Procaster is low-output — if gain is near max, add an inline preamp (Cloudlifter/FetHead).',
    muddy: 'Procaster proximity effect is strong up close — back off before EQ-ing out the boom.',
  }},
  q2u:       { label: 'Samson Q2U / AT2005', type: 'dynamic',   tips: {
    noise: 'Budget dynamic — gate hard and get within a fist\'s distance to keep the room out.',
  }},
};

// ── Signal-chain catalog ──────────────────────────────────────────────────────
// `how(issue)` returns gear-specific instructions, or null to fall through.
const CHAINS = {
  obs: {
    label: 'Straight into OBS (no hardware)',
    how: () => null, // keep the generic OBS text
  },

  goxlr: {
    label: 'GoXLR / GoXLR Mini',
    how: (issue) => ({
      loud:       'GoXLR: pull the Mic channel fader down, or lower Mic → Gain in the app.',
      quiet:      'GoXLR: raise Mic → Gain (SM7B-class mics often need it near the top).',
      clip:         'GoXLR: back off Mic → Gain first; the input is clipping before OBS ever sees it.',
      peak:         'GoXLR: nudge the Mic fader down a touch, or lower Mic → Gain.',
      'dyn-wide':   'GoXLR: Compressor tab → Ratio ~3:1, Threshold around −18 dB.',
      'dyn-narrow': 'GoXLR: Compressor tab → raise Threshold / lower Ratio; you\'re over-compressing.',
      noise:      'GoXLR: Gate tab → Threshold ~−40 dB, Attenuation 100%, Release ~200 ms.',
      muddy:      'GoXLR: Equaliser tab → high-pass ~80 Hz and cut the 200–300 Hz band a few dB.',
      harsh:      'GoXLR: Equaliser tab → pull down the 6–8 kHz band a few dB.',
    }[issue] || null),
  },

  dbx286: {
    label: 'dbx 286s channel strip',
    how: (issue) => ({
      loud:       'dbx 286s: lower the Output Gain knob.',
      quiet:      'dbx 286s: raise the Input Gain (watch the OL/clip LED).',
      clip:       'dbx 286s: back off Input Gain until the OL LED stops flashing; engage the peak limiter.',
      peak:       'dbx 286s: engage the built-in Peak Stop limiter.',
      'dyn-wide':   'dbx 286s: Compressor section → raise Drive, set a moderate ratio.',
      'dyn-narrow': 'dbx 286s: reduce Drive — the compressor is working too hard.',
      noise:      'dbx 286s: raise the Downward Expander/Gate until hiss drops out between phrases.',
      muddy:      'dbx 286s: engage the Low-Cut (high-pass) filter and dial the Bass EQ back.',
      harsh:      'dbx 286s: reduce the High-Freq De-Esser threshold, or trim the Treble EQ.',
    }[issue] || null),
  },

  rodecaster: {
    label: 'RodeCaster Pro / Pro II',
    how: (issue) => ({
      loud:         'RodeCaster: lower the channel fader, or turn down that input\'s gain in the settings.',
      quiet:        'RodeCaster: raise the input gain for that channel (it has plenty for dynamic mics).',
      clip:         'RodeCaster: back off the input gain until the level meter stops hitting the top red.',
      peak:         'RodeCaster: trim the channel fader / input gain down a touch.',
      'dyn-wide':   'RodeCaster: enable the channel Compressor (Advanced processing), moderate settings.',
      'dyn-narrow': 'RodeCaster: ease off the Compressor amount on that channel.',
      noise:        'RodeCaster: turn on the Noise Gate for the mic channel in Advanced processing.',
      muddy:        'RodeCaster: enable the High-Pass Filter and pull the low band down in the channel EQ.',
      harsh:        'RodeCaster: enable the De-Esser, or trim the high band in the channel EQ.',
    }[issue] || null),
  },

  wavexlr: {
    label: 'Elgato Wave XLR / Wave Link',
    how: (issue) => ({
      loud:  'Wave XLR: lower the channel level in Wave Link.',
      quiet: 'Wave XLR: raise the front gain dial (up to +75 dB — good for dynamics).',
      clip:  'Wave XLR: Clipguard helps, but lower the front gain dial until the ring stops flashing red.',
      peak:  'Wave XLR: trim the front gain dial down slightly.',
      // No onboard comp/gate/EQ → dynamics & EQ fall through to OBS/plugins.
    }[issue] || null),
  },

  interface: {
    label: 'USB audio interface (Scarlett/Volt/etc.)',
    how: (issue) => ({
      loud:  'Interface: lower the monitor/output knob, or trim OBS gain.',
      quiet: 'Interface: raise the input gain knob (dynamic mics want +50–60 dB).',
      clip:  'Interface: lower the input gain knob until the peak LED stops flashing — fix it at the source before software.',
      peak:  'Interface: trim the input gain knob down slightly.',
      // dynamics / eq: interfaces rarely have onboard DSP → fall through to OBS.
    }[issue] || null),
  },
};

// ── Current selection (defaults to fully generic) ─────────────────────────────
const hardware = { mic: 'generic', chain: 'obs' };

function initHardwareSelectors() {
  const micSel   = document.getElementById('hw-mic');
  const chainSel = document.getElementById('hw-chain');
  if (micSel) {
    micSel.innerHTML = Object.entries(MICS)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    micSel.addEventListener('change', e => { hardware.mic = e.target.value; });
  }
  if (chainSel) {
    chainSel.innerHTML = Object.entries(CHAINS)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
    chainSel.addEventListener('change', e => { hardware.chain = e.target.value; });
  }
}

// ── Resolvers used by the corrections engine ──────────────────────────────────
// All take an optional `hw` selection ({ mic, chain }) so a saved report can be
// rendered against the gear chosen at stop time. Defaults to the live selection.

// Should this correction be hidden for the selected mic?
function hardwareSuppresses(issue, hw = hardware) {
  const mic = MICS[hw.mic];
  if (!mic || !mic.type) return false;
  // Sibilance/harshness tips are a condenser problem; don't nag dynamic-mic users.
  if (issue === 'harsh' && mic.type === 'dynamic') return true;
  return false;
}

// Best gear-specific advice for this issue, or null. Mic tip wins over chain
// (it's more targeted).
function hardwareTip(issue, hw = hardware) {
  const mic = MICS[hw.mic];
  if (mic && mic.tips && mic.tips[issue]) return mic.tips[issue];
  const chain = CHAINS[hw.chain];
  if (chain) return chain.how(issue);
  return null;
}

// Overwrite the `how` line of issue-tagged corrections; drop suppressed ones.
function applyHardware(corrs, hw = hardware) {
  return corrs
    .filter(c => !c.issue || !hardwareSuppresses(c.issue, hw))
    .map(c => {
      if (!c.issue) return c;
      const tip = hardwareTip(c.issue, hw);
      return tip ? { ...c, how: tip } : c;
    });
}

// Snapshot the current selection so a report stays accurate after the dropdowns change.
function snapshot() { return { mic: hardware.mic, chain: hardware.chain }; }

// Is any non-generic gear selected? (used to decide whether to show a report note)
function isActive(hw = hardware) { return hw.mic !== 'generic' || hw.chain !== 'obs'; }

function label(hw = hardware) {
  const m = MICS[hw.mic]?.label || 'generic mic';
  const c = CHAINS[hw.chain]?.label || 'no hardware';
  return `${m} → ${c}`;
}

window.HardwareAdvice = {
  initHardwareSelectors, applyHardware, hardwareTip, hardwareSuppresses,
  snapshot, isActive, label, hardware,
};
