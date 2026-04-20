/**
 * api/data.js  —  Vercel Serverless Function
 *
 * GET  /api/data        → returns current inventory state as JSON
 * POST /api/data        → saves new state, returns saved state
 *
 * Storage: Vercel KV (free tier — set up once in Vercel dashboard)
 * Env vars required (auto-injected when you link KV store):
 *   KV_REST_API_URL
 *   KV_REST_API_TOKEN
 */

const KV_KEY = 'amdesigns-inventory-state';

// ── tiny KV helper (uses Vercel KV REST API directly, no SDK needed) ──
async function kvGet() {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/get/${KV_KEY}`,
    { headers: { Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}` } }
  );
  if (!res.ok) return null;
  const json = await res.json();
  return json.result ? JSON.parse(json.result) : null;
}

async function kvSet(value) {
  const res = await fetch(
    `${process.env.KV_REST_API_URL}/set/${KV_KEY}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: JSON.stringify(value) }),
    }
  );
  return res.ok;
}

export default async function handler(req, res) {
  // CORS — allow your Vercel domain and localhost
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ── KV not configured — fallback so local dev still works ──
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    if (req.method === 'GET') {
      return res.status(200).json({ ok: false, error: 'KV_NOT_CONFIGURED', data: null });
    }
    if (req.method === 'POST') {
      return res.status(200).json({ ok: false, error: 'KV_NOT_CONFIGURED' });
    }
  }

  // ── GET ──
  if (req.method === 'GET') {
    try {
      const data = await kvGet();
      return res.status(200).json({ ok: true, data });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── POST ──
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ ok: false, error: 'Invalid body' });
      }
      // Always stamp the save time
      body.lastSaved = new Date().toISOString();
      await kvSet(body);
      return res.status(200).json({ ok: true, data: body });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
