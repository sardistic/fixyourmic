const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '32kb' }));

// Resolve streamlink binary path once at startup — handles cases where the
// system PATH seen by Node.js differs from the shell PATH (common on Windows).
let STREAMLINK_BIN = 'streamlink';
try {
  // 'where' is Windows-only; Linux/Docker uses 'which'
  const whichCmd = process.platform === 'win32' ? 'where streamlink' : 'which streamlink';
  const found = execSync(whichCmd, { encoding: 'utf8' }).trim().split('\n')[0].trim();
  if (found) STREAMLINK_BIN = found;
} catch {
  // keep default
}
console.log(`streamlink: ${STREAMLINK_BIN}`);

// Curated fallback if the Twitch directory query fails — big, almost-always-live names.
const FALLBACK_TOP = [
  { login: 'caseoh_', display: 'CaseOh' },
  { login: 'xqc', display: 'xQc' },
  { login: 'jynxzi', display: 'Jynxzi' },
  { login: 'kaicenat', display: 'Kai Cenat' },
  { login: 'summit1g', display: 'summit1g' },
  { login: 'tarik', display: 'tarik' },
];

// Cache top-live results for 60s to avoid hammering Twitch GQL on every page load.
let topCache = { data: null, ts: 0 };

// Returns currently-live top Twitch channels for the suggestion chips.
app.get('/api/top', async (req, res) => {
  const now = Date.now();
  if (topCache.data && now - topCache.ts < 60000) {
    return res.json({ channels: topCache.data, cached: true });
  }
  try {
    const query = 'query{streams(first:12,options:{sort:VIEWER_COUNT}){edges{node{viewersCount broadcaster{login displayName} game{displayName}}}}}';
    const r = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      headers: { 'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const j = await r.json();
    const edges = j?.data?.streams?.edges || [];
    const channels = edges
      .filter(e => e?.node?.broadcaster?.login)
      .map(e => ({
        login: e.node.broadcaster.login,
        display: e.node.broadcaster.displayName || e.node.broadcaster.login,
        viewers: e.node.viewersCount,
        game: e.node.game?.displayName || '',
      }))
      .slice(0, 6);

    if (channels.length) {
      topCache = { data: channels, ts: now };
      return res.json({ channels });
    }
    res.json({ channels: FALLBACK_TOP });
  } catch (err) {
    console.error('top error:', err.message);
    res.json({ channels: FALLBACK_TOP });
  }
});

// Resolve any live stream URL to a playable HLS URL via streamlink.
// Supports Twitch, YouTube Live, Kick, and many other platforms.
// Returns { url } — the CDN HLS URL with CORS * that hls.js can load directly.
app.get('/api/stream', (req, res) => {
  const streamUrl = req.query.url?.trim();
  if (!streamUrl) return res.status(400).json({ error: 'URL required' });

  if (!/^(https?:\/\/(www\.)?twitch\.tv\/)/.test(streamUrl)) {
    return res.status(400).json({ error: 'Enter a Twitch channel URL (e.g. https://www.twitch.tv/channelname)' });
  }

  // Prefer audio_only on Twitch (no video bandwidth wasted).
  // Fall back through lower video qualities for other platforms.
  const qualities = 'audio_only,160p,360p,480p,worst';

  execFile(
    STREAMLINK_BIN,
    ['--stream-url', streamUrl, qualities],
    { timeout: 25000 },
    (err, stdout, stderr) => {
      const output = stdout?.trim();
      if (err || !output) {
        // streamlink writes error messages to stdout, not stderr
        const msg = (output || stderr || err?.message || '').trim();
        console.error('streamlink error:', msg || '(no output)');
        if (msg.includes('No playable streams') || msg.includes('No streams') || msg.includes('404')) {
          return res.status(404).json({ error: 'Channel is offline or not found.' });
        }
        if (msg.includes('Unable to open URL') || msg.includes('invalid') || msg.includes('No plugin')) {
          return res.status(400).json({ error: 'Unsupported or invalid stream URL.' });
        }
        return res.status(502).json({ error: `streamlink: ${msg.slice(0, 200) || 'unknown error'}` });
      }

      // Route all HLS through our proxy so every Twitch CDN request comes from
      // the same server IP that streamlink used to generate the access token.
      // Loading the URL directly in the browser fails with 403 (IP mismatch).
      const hlsUrl = output.split('\n')[0];
      res.json({ url: `/proxy?url=${encodeURIComponent(hlsUrl)}` });
    }
  );
});

// HLS proxy — used for manual direct .m3u8 URLs where the CDN may not have CORS headers.
// Rewrites nested m3u8 URL references so all segment requests also go through this proxy.
app.get('/proxy', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send('URL required');

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      return res.status(response.status).send(`Upstream returned ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || '';
    const isPlaylist = url.includes('.m3u8') || contentType.includes('mpegurl');

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (isPlaylist) {
      const text = await response.text();
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(rewriteM3u8(text, url));
    } else {
      res.setHeader('Content-Type', contentType || 'video/MP2T');
      response.body.pipe(res);
    }
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).send(`Proxy error: ${err.message}`);
  }
});

const transcriptSessions = new Map();

app.post('/api/transcript/start', (req, res) => {
  const streamUrl = req.body?.url?.trim();
  if (!streamUrl) return res.status(400).json({ error: 'URL required' });
  if (!/^https?:\/\/(www\.)?twitch\.tv\/[a-zA-Z0-9_]{1,25}/.test(streamUrl)) {
    return res.status(400).json({ error: 'Enter a Twitch channel URL.' });
  }
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Live transcript needs OPENAI_API_KEY on the server.' });
  }

  const id = crypto.randomUUID();
  const session = {
    id,
    streamUrl,
    startedAt: Date.now(),
    status: 'starting',
    running: true,
    segments: [],
    lastError: null,
    chunkIndex: 0,
  };
  transcriptSessions.set(id, session);
  runTranscriptSession(session).catch(err => {
    session.status = 'error';
    session.lastError = err.message;
    session.running = false;
  });
  res.json({ id, status: session.status });
});

app.get('/api/transcript/:id', (req, res) => {
  const session = transcriptSessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Transcript session not found.' });
  res.json({
    id: session.id,
    status: session.status,
    startedAt: session.startedAt,
    lastError: session.lastError,
    segments: session.segments.slice(-12),
  });
});

app.post('/api/transcript/:id/stop', (req, res) => {
  const session = transcriptSessions.get(req.params.id);
  if (!session) return res.json({ ok: true });
  session.running = false;
  session.status = 'stopped';
  setTimeout(() => transcriptSessions.delete(req.params.id), 30000);
  res.json({ ok: true });
});

async function runTranscriptSession(session) {
  session.status = 'resolving';
  const hlsUrl = await resolveStreamUrl(session.streamUrl);
  while (session.running) {
    session.status = 'listening';
    const chunkPath = path.join(os.tmpdir(), `fixyourmic-${session.id}-${session.chunkIndex++}.mp3`);
    try {
      await captureAudioChunk(hlsUrl, chunkPath);
      session.status = 'transcribing';
      const text = await transcribeAudioFile(chunkPath);
      if (text) {
        session.segments.push({
          id: crypto.randomUUID(),
          t: Date.now(),
          text,
          confidence: estimateTranscriptConfidence(text),
        });
        if (session.segments.length > 80) session.segments.splice(0, session.segments.length - 80);
      }
      session.status = 'listening';
    } catch (err) {
      session.lastError = err.message;
      session.status = 'error';
      await sleep(4000);
    } finally {
      fs.promises.unlink(chunkPath).catch(() => {});
    }
    await sleep(2500);
  }
}

function resolveStreamUrl(streamUrl) {
  return new Promise((resolve, reject) => {
    execFile(
      STREAMLINK_BIN,
      ['--stream-url', streamUrl, 'audio_only,160p,360p,worst'],
      { timeout: 25000 },
      (err, stdout, stderr) => {
        const output = stdout?.trim();
        if (err || !output) {
          const msg = (output || stderr || err?.message || '').trim();
          reject(new Error(msg.slice(0, 200) || 'Unable to resolve stream audio.'));
          return;
        }
        resolve(output.split('\n')[0]);
      }
    );
  });
}

function captureAudioChunk(hlsUrl, outPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', hlsUrl, '-t', '8', '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', outPath],
      { timeout: 18000 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'ffmpeg failed').trim().slice(0, 200)));
          return;
        }
        resolve();
      }
    );
  });
}

async function transcribeAudioFile(filePath) {
  const boundary = `----fixyourmic-${crypto.randomBytes(12).toString('hex')}`;
  const audio = await fs.promises.readFile(filePath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\ngpt-4o-mini-transcribe\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `transcription failed (${response.status})`);
  }
  return (data.text || '').trim();
}

function estimateTranscriptConfidence(text) {
  if (!text) return 'low';
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words >= 12) return 'high';
  if (words >= 5) return 'medium';
  return 'low';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function rewriteM3u8(content, baseUrl) {
  return content.split('\n').map(line => {
    const trimmed = line.trim();
    if (trimmed === '') return line;
    if (trimmed.startsWith('#')) {
      return trimmed.replace(/URI="([^"]+)"/g, (_, uri) => {
        const abs = resolveUrl(uri, baseUrl);
        return `URI="/proxy?url=${encodeURIComponent(abs)}"`;
      });
    }
    const abs = resolveUrl(trimmed, baseUrl);
    return `/proxy?url=${encodeURIComponent(abs)}`;
  }).join('\n');
}

function resolveUrl(url, base) {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try { return new URL(url, base).toString(); } catch { return url; }
}

// Shareable channel routes, e.g. /cyr -> same app shell, frontend starts twitch.tv/cyr.
// Keep this after API/proxy/static routes so it only catches channel-like slugs.
app.get(/^\/([A-Za-z0-9_]{1,25})\/+$/, (req, res) => {
  res.redirect(301, `/${req.params[0]}`);
});

app.get(/^\/([A-Za-z0-9_]{1,25})$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Stream Audio Analyzer → http://localhost:${PORT}`);
});
