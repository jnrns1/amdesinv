/**
 * api/data.js — Vercel Serverless Function
 *
 * GET  /api/data  → read inventory state from Edge Config
 * POST /api/data  → write inventory state to Edge Config
 *
 * Required env vars (auto-injected when you link Edge Config in Vercel):
 *   EDGE_CONFIG          — connection string, e.g. https://edge-config.vercel.com/ecfg_xxx?token=xxx
 *   EDGE_CONFIG_TOKEN    — your Vercel API token (create at vercel.com/account/tokens)
 *   EDGE_CONFIG_ID       — your Edge Config store ID, e.g. ecfg_xxxxxxxxxxxxxxxx
 */

import { get } from '@vercel/edge-config';

const EDGE_KEY = 'inventory';

async function edgeRead() {
  // Uses the EDGE_CONFIG connection string env var automatically
  return await get(EDGE_KEY);
}

async function edgeWrite(data) {
  const res = await fetch(
    `https://api.vercel.com/v1/edge-config/${process.env.EDGE_CONFIG_ID}/items`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.EDGE_CONFIG_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: [{ operation: 'upsert', key: EDGE_KEY, value: data }],
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Edge Config write failed: ${text}`);
  }
  return true;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const configured =
    process.env.EDGE_CONFIG &&
    process.env.EDGE_CONFIG_TOKEN &&
    process.env.EDGE_CONFIG_ID;

  if (!configured) {
    return res.status(200).json({ ok: false, error: 'EDGE_NOT_CONFIGURED', data: null });
  }

  // ── GET ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const data = await edgeRead();
      return res.status(200).json({ ok: true, data: data || null });
    } catch (err) {
      console.error('GET /api/data:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch {}
      }
      if (!body || typeof body !== 'object') {
        return res.status(400).json({ ok: false, error: 'Invalid body' });
      }
      body.lastSaved = new Date().toISOString();
      await edgeWrite(body);
      return res.status(200).json({ ok: true, data: body });
    } catch (err) {
      console.error('POST /api/data:', err.message);
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
