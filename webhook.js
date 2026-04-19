/**
 * AMDesigns Inventory Webhook Server
 * ─────────────────────────────────────────────────────────────────────
 * Listens for POST /webhook/inventory events and updates the Excel
 * file (stock_control_shopify_ready.xlsx) + auto-exports a live CSV.
 *
 * Also accepts Shopify inventory_levels/update webhook natively.
 *
 * Setup:
 *   npm install express xlsx crypto-js cors dotenv
 *   node webhook.js
 *
 * Env vars (create a .env file — never commit it):
 *   WEBHOOK_SECRET=your_secret_here
 *   SHOPIFY_ACCESS_TOKEN=shpat_...
 *   SHOPIFY_STORE_DOMAIN=yourstore.myshopify.com
 *   PORT=3000
 *   EXCEL_FILE=./stock_control_shopify_ready.xlsx
 * ─────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();

const express  = require('express');
const crypto   = require('crypto');
const XLSX     = require('xlsx');
const fs       = require('fs');
const path     = require('path');
const cors     = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;

const EXCEL_FILE    = path.resolve(process.env.EXCEL_FILE || './stock_control_shopify_ready.xlsx');
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const LOCATIONS     = ['Studio', 'Knokke', 'Warehouse'];

// ─── Middleware ────────────────────────────────────────────────────────
app.use(cors());

// Raw body capture for HMAC verification (Shopify requires raw body)
app.use((req, res, next) => {
  let data = '';
  req.on('data', chunk => { data += chunk; });
  req.on('end', () => {
    req.rawBody = data;
    try { req.body = JSON.parse(data); } catch { req.body = {}; }
    next();
  });
});

// ─── HMAC Verification Helper ──────────────────────────────────────────
function verifyShopifyHmac(req) {
  if (!WEBHOOK_SECRET) return true; // skip if no secret configured
  const hmacHeader = req.headers['x-shopify-hmac-sha256'] || req.headers['x-webhook-signature'];
  if (!hmacHeader) return false;
  const computed = crypto
    .createHmac('sha256', WEBHOOK_SECRET)
    .update(req.rawBody, 'utf8')
    .digest('base64');
  return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(hmacHeader));
}

// ─── Excel Helpers ─────────────────────────────────────────────────────
function readWorkbook() {
  if (!fs.existsSync(EXCEL_FILE)) {
    throw new Error(`Excel file not found: ${EXCEL_FILE}`);
  }
  return XLSX.readFile(EXCEL_FILE, { cellStyles: true, bookVBA: false });
}

function saveWorkbook(wb) {
  XLSX.writeFile(wb, EXCEL_FILE, { compression: true });
}

function sheetToJson(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
}

function jsonToSheet(data, headers) {
  return XLSX.utils.json_to_sheet(data, { header: headers });
}

function updateSheet(wb, sheetName, data, headers) {
  wb.Sheets[sheetName] = jsonToSheet(data, headers);
}

// ─── Inventory Calculation ─────────────────────────────────────────────
function recalcInventory(catalog, transactions) {
  return catalog
    .filter(item => item.SKU)
    .map(item => {
      const totals = {};
      LOCATIONS.forEach(loc => {
        totals[loc] = transactions
          .filter(tx => tx.SKU === item.SKU && tx.Location === loc)
          .reduce((sum, tx) => {
            const positive = ['Received','Transfer In','Adjustment In','Return In'];
            const qty = Number(tx.Qty || 0);
            return sum + (positive.includes(tx['Movement Type']) ? qty : -qty);
          }, 0);
      });

      const total = LOCATIONS.reduce((s, loc) => s + (totals[loc] || 0), 0);
      const reorder = Number(item['Reorder Point'] || 0);
      const status = total <= 0 ? 'Out of stock' : total <= reorder ? 'Reorder' : 'Healthy';

      return {
        SKU: item.SKU,
        Product: item.Product,
        Variant: item.Variant,
        Studio: totals['Studio'] || 0,
        Knokke: totals['Knokke'] || 0,
        Warehouse: totals['Warehouse'] || 0,
        Total: total,
        'Reorder Point': reorder,
        Status: status,
        Handle: item.Handle,
        Cost: Number(item.Cost || 0),
        'Stock @ Cost': total * Number(item.Cost || 0),
        'Stock @ Retail': total * Number(item['Retail Price'] || 0),
        Last_Webhook_Update: new Date().toISOString()
      };
    });
}

// ─── Log to Last_Sync sheet ────────────────────────────────────────────
function appendSyncLog(wb, entries) {
  const sheetName = 'Last_Sync';
  let existing = [];
  try { existing = sheetToJson(wb, sheetName); } catch {}

  // Keep most recent 500 entries
  const combined = [...entries, ...existing].slice(0, 500);
  const headers = ['Timestamp','SKU','Location','Old Qty','New Qty','Delta','Source'];
  updateSheet(wb, sheetName, combined, headers);
}

// ─── Export live CSV ───────────────────────────────────────────────────
function exportInventoryCsv(wb) {
  try {
    const inventory = sheetToJson(wb, 'Inventory_Live');
    const csvPath   = path.join(path.dirname(EXCEL_FILE), 'inventory_live_export.csv');
    const ws        = XLSX.utils.json_to_sheet(inventory);
    XLSX.writeFile({ SheetNames: ['Sheet1'], Sheets: { Sheet1: ws } }, csvPath);
    console.log(`[${new Date().toISOString()}] CSV exported → ${csvPath}`);
  } catch (err) {
    console.error('CSV export failed:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'AMDesigns Inventory Webhook',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    excelFile: EXCEL_FILE,
    endpoints: {
      'POST /webhook/inventory':        'Update stock levels directly (JSON)',
      'POST /webhook/transaction':      'Log a new transaction and recalculate',
      'POST /webhook/shopify/inventory':'Shopify inventory_levels/update webhook',
      'GET  /api/inventory':            'Get current live inventory JSON',
      'GET  /api/catalog':              'Get current catalog JSON',
    }
  });
});

// ── GET current inventory ──────────────────────────────────────────────
app.get('/api/inventory', (req, res) => {
  try {
    const wb = readWorkbook();
    res.json({ success: true, data: sheetToJson(wb, 'Inventory_Live') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── GET catalog ────────────────────────────────────────────────────────
app.get('/api/catalog', (req, res) => {
  try {
    const wb = readWorkbook();
    res.json({ success: true, data: sheetToJson(wb, 'Catalog') });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /webhook/transaction ──────────────────────────────────────────
// Add a new transaction row and fully recalculate inventory.
//
// Body: {
//   date: "2026-04-19",
//   sku: "SKU-001",
//   movementType: "Sold",
//   qty: 2,
//   location: "Studio",
//   reference: "SALE-042",
//   notes: "Online order"
// }
app.post('/webhook/transaction', (req, res) => {
  if (!verifyShopifyHmac(req)) {
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  const { date, sku, movementType, qty, location, reference, notes } = req.body;

  if (!sku || !movementType || !qty || !location) {
    return res.status(400).json({ success: false, error: 'Missing required fields: sku, movementType, qty, location' });
  }

  try {
    const wb           = readWorkbook();
    const catalog      = sheetToJson(wb, 'Catalog');
    const transactions = sheetToJson(wb, 'Transactions');

    const newTx = {
      Date: date || new Date().toISOString().slice(0, 10),
      SKU: sku.toUpperCase(),
      'Movement Type': movementType,
      Qty: Number(qty),
      Location: location,
      Reference: reference || '',
      Notes: notes || '',
      'Signed Qty': ['Received','Transfer In','Adjustment In','Return In'].includes(movementType)
        ? Number(qty) : -Number(qty)
    };

    transactions.unshift(newTx);

    const txHeaders = ['Date','SKU','Movement Type','Qty','Location','Reference','Notes','Signed Qty'];
    updateSheet(wb, 'Transactions', transactions, txHeaders);

    const newInventory = recalcInventory(catalog, transactions);
    const invHeaders   = ['SKU','Product','Variant','Studio','Knokke','Warehouse','Total','Reorder Point','Status','Handle','Cost','Stock @ Cost','Stock @ Retail','Last_Webhook_Update'];
    updateSheet(wb, 'Inventory_Live', newInventory, invHeaders);

    const logEntry = {
      Timestamp: new Date().toISOString(),
      SKU: sku,
      Location: location,
      'Old Qty': '(recalc)',
      'New Qty': '(recalc)',
      Delta: newTx['Signed Qty'],
      Source: 'webhook/transaction'
    };
    appendSyncLog(wb, [logEntry]);
    saveWorkbook(wb);
    exportInventoryCsv(wb);

    console.log(`[${new Date().toISOString()}] Transaction logged: ${sku} ${movementType} ${qty} @ ${location}`);
    res.json({ success: true, message: 'Transaction logged and inventory recalculated', transaction: newTx });

  } catch (err) {
    console.error('Transaction error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /webhook/inventory ────────────────────────────────────────────
// Directly set inventory quantities for one or more SKU/location combos.
//
// Body: {
//   updates: [
//     { sku: "SKU-001", location: "Studio", qty: 10 },
//     { sku: "SKU-002", location: "Warehouse", qty: 5 }
//   ],
//   source: "shopify" | "manual" | ...
// }
app.post('/webhook/inventory', (req, res) => {
  if (!verifyShopifyHmac(req)) {
    return res.status(401).json({ success: false, error: 'Invalid signature' });
  }

  const { updates, source } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ success: false, error: 'Body must contain an "updates" array' });
  }

  try {
    const wb           = readWorkbook();
    const catalog      = sheetToJson(wb, 'Catalog');
    let   transactions = sheetToJson(wb, 'Transactions');
    const syncLog      = [];
    const timestamp    = new Date().toISOString();
    const today        = timestamp.slice(0, 10);

    updates.forEach(({ sku, location, qty }) => {
      if (!sku || !location || qty == null) return;

      const skuUpper = sku.toUpperCase();
      const loc      = LOCATIONS.find(l => l.toLowerCase() === location.toLowerCase()) || location;

      // Calculate current qty for this SKU/location
      const currentQty = transactions
        .filter(tx => tx.SKU === skuUpper && tx.Location === loc)
        .reduce((sum, tx) => {
          const positive = ['Received','Transfer In','Adjustment In','Return In'];
          return sum + (['Received','Transfer In','Adjustment In','Return In'].includes(tx['Movement Type'])
            ? Number(tx.Qty || 0) : -Number(tx.Qty || 0));
        }, 0);

      const targetQty = Number(qty);
      const delta     = targetQty - currentQty;

      if (delta === 0) return; // No change needed

      const movementType = delta > 0 ? 'Adjustment In' : 'Adjustment Out';
      const adjQty       = Math.abs(delta);

      const newTx = {
        Date: today,
        SKU: skuUpper,
        'Movement Type': movementType,
        Qty: adjQty,
        Location: loc,
        Reference: `WEBHOOK-${timestamp.slice(0,10)}`,
        Notes: `Auto-sync from ${source || 'webhook'} — set to ${targetQty}`,
        'Signed Qty': delta
      };

      transactions.unshift(newTx);
      syncLog.push({
        Timestamp: timestamp,
        SKU: skuUpper,
        Location: loc,
        'Old Qty': currentQty,
        'New Qty': targetQty,
        Delta: delta,
        Source: source || 'webhook/inventory'
      });
    });

    const txHeaders = ['Date','SKU','Movement Type','Qty','Location','Reference','Notes','Signed Qty'];
    updateSheet(wb, 'Transactions', transactions, txHeaders);

    const newInventory = recalcInventory(catalog, transactions);
    const invHeaders   = ['SKU','Product','Variant','Studio','Knokke','Warehouse','Total','Reorder Point','Status','Handle','Cost','Stock @ Cost','Stock @ Retail','Last_Webhook_Update'];
    updateSheet(wb, 'Inventory_Live', newInventory, invHeaders);

    if (syncLog.length > 0) {
      appendSyncLog(wb, syncLog);
    }

    saveWorkbook(wb);
    exportInventoryCsv(wb);

    console.log(`[${timestamp}] Inventory webhook processed: ${syncLog.length} updates`);
    res.json({ success: true, message: `Inventory updated (${syncLog.length} changes)`, changes: syncLog });

  } catch (err) {
    console.error('Inventory webhook error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── POST /webhook/shopify/inventory ───────────────────────────────────
// Native Shopify inventory_levels/update webhook handler.
// Shopify sends: { inventory_item_id, location_id, available, ... }
// You need to map inventory_item_id → SKU in Webhook_Config or Catalog.
app.post('/webhook/shopify/inventory', (req, res) => {
  if (!verifyShopifyHmac(req)) {
    return res.status(401).json({ success: false, error: 'Invalid Shopify HMAC signature' });
  }

  const topic = req.headers['x-shopify-topic'];
  console.log(`[Shopify webhook] topic=${topic}`, req.body);

  // Shopify sends inventory_item_id + available qty + location_id
  // We map location_id to our location names via the Webhook_Config sheet
  const { inventory_item_id, available, location_id } = req.body;

  try {
    const wb      = readWorkbook();
    const catalog = sheetToJson(wb, 'Catalog');

    // Try to find SKU by barcode or by a Shopify_Inventory_Item_ID column
    const item = catalog.find(i =>
      String(i.Shopify_Inventory_Item_ID) === String(inventory_item_id) ||
      String(i.Barcode) === String(inventory_item_id)
    );

    if (!item) {
      console.warn(`No catalog match for inventory_item_id=${inventory_item_id}`);
      return res.status(200).json({ success: true, message: 'No matching SKU — ignored' });
    }

    // Map Shopify location_id to our location name
    // Update Webhook_Config sheet to add location mappings
    const configRows = sheetToJson(wb, 'Webhook_Config');
    const locationMap = {};
    configRows.filter(r => r.Setting && r.Setting.startsWith('location_id_'))
      .forEach(r => { locationMap[r.Setting.replace('location_id_', '')] = r.Value; });

    const ourLocation = locationMap[String(location_id)] || 'Warehouse';

    // Delegate to inventory update logic
    req.body = {
      updates: [{ sku: item.SKU, location: ourLocation, qty: available }],
      source: `shopify/${topic}`
    };
    // Re-route to the inventory webhook handler
    return app._router.handle(
      Object.assign(req, { url: '/webhook/inventory', method: 'POST' }),
      res, () => {}
    );

  } catch (err) {
    console.error('Shopify webhook error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 404 ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: `Unknown endpoint: ${req.method} ${req.url}` });
});

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('');
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   AMDesigns Inventory Webhook Server           ║');
  console.log(`║   Listening on port ${PORT}                       ║`);
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Excel file : ${EXCEL_FILE}`);
  console.log(`Secret set : ${WEBHOOK_SECRET ? 'YES ✓' : 'NO (set WEBHOOK_SECRET in .env!)'}`);
  console.log('');
  console.log('Endpoints:');
  console.log(`  GET  http://localhost:${PORT}/`);
  console.log(`  GET  http://localhost:${PORT}/api/inventory`);
  console.log(`  GET  http://localhost:${PORT}/api/catalog`);
  console.log(`  POST http://localhost:${PORT}/webhook/transaction`);
  console.log(`  POST http://localhost:${PORT}/webhook/inventory`);
  console.log(`  POST http://localhost:${PORT}/webhook/shopify/inventory`);
  console.log('');
});

module.exports = app;
