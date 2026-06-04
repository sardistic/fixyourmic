const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const { execFile, execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

// Resolve streamlink binary path once at startup — handles cases where the
// system PATH seen by Node.js differs from the shell PATH (common on Windows).
let STREAMLINK_BIN = 'streamlink';
try {
  const found = execSync('where streamlink', { encoding: 'utf8' }).trim().split('\n')[0].trim();
  if (found) STREAMLINK_BIN = found;
} catch {
  // 'where' failed; keep default and let execFile surface the error naturally
}
console.log(`streamlink: ${STREAMLINK_BIN}`);

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

      const hlsUrl = output.split('\n')[0];
      res.json({ url: hlsUrl });
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

app.listen(PORT, () => {
  console.log(`Stream Audio Analyzer → http://localhost:${PORT}`);
});
