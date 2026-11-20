import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createDefaultOverlayState, type LiveOverlayState } from './src/types/overlay.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const isProd = process.env.NODE_ENV === 'production';
const ADMIN_PIN = (process.env.OVERLAY_ADMIN_PIN || '9890').trim();
const UNLOCK_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

const VALID_SKUS = new Set([
  'kabaddi-classic',
  'kabaddi-modern',
  'haldi-classic',
  'haldi-modern',
]);

export type OrderStatus = 'pending' | 'approved' | 'rejected';

interface OverlayOrder {
  orderId: string;
  sku: string;
  amount: number;
  originalPrice: number;
  buyerName: string;
  buyerPhone: string;
  utrRef: string;
  proofImage?: string;
  status: OrderStatus;
  unlockCode?: string;
  rejectionReason?: string;
  createdAt: number;
  verifiedAt?: number;
  expiresAt?: number;
}

function getOrderExpiresAt(order: OverlayOrder): number {
  if (typeof order.expiresAt === 'number') return order.expiresAt;
  const base = order.verifiedAt || order.createdAt;
  return base + UNLOCK_DURATION_MS;
}

function isOrderActive(order: OverlayOrder, now = Date.now()): boolean {
  return order.status === 'approved' && Boolean(order.unlockCode) && getOrderExpiresAt(order) > now;
}

const DATA_DIR = path.resolve(__dirname, 'data');
const ORDERS_FILE = path.join(DATA_DIR, 'overlay-orders.json');

function loadPersistedOrders(): OverlayOrder[] {
  try {
    if (!fs.existsSync(ORDERS_FILE)) return [];
    const raw = fs.readFileSync(ORDERS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function savePersistedOrders(orders: OverlayOrder[]) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to persist overlay orders:', err);
  }
}

function generateOrderId(): string {
  const rand = crypto.randomInt(100000, 999999);
  return `OVL-${rand}`;
}

function generateUnlockCode(): string {
  const part1 = crypto.randomBytes(2).toString('hex').toUpperCase();
  const part2 = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `STAR-${part1}-${part2}`;
}

// Authoritative server-side room store for OBS & vMix Browser Sources
const rooms = new Map<string, LiveOverlayState>();
const sseClients = new Map<string, Set<express.Response>>();

// Authoritative server-side payment orders store
const orders: OverlayOrder[] = loadPersistedOrders();
const orderSseClients = new Map<string, Set<express.Response>>();

function sanitizeRoomId(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-_]/g, '').slice(0, 40);
  return cleaned || 'star-live-1';
}

function getOrCreateRoom(roomId: string): LiveOverlayState {
  const safeId = sanitizeRoomId(roomId);
  let state = rooms.get(safeId);
  if (!state) {
    state = createDefaultOverlayState(safeId);
    rooms.set(safeId, state);
  }
  return state;
}

function broadcastRoomState(roomId: string, state: LiveOverlayState) {
  const clients = sseClients.get(roomId);
  if (!clients || clients.size === 0) return;

  const payload = JSON.stringify({
    state,
    connectedDisplays: clients.size,
  });

  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function toPublicOrderSummary(order: OverlayOrder) {
  const expiresAt = order.status === 'approved' ? getOrderExpiresAt(order) : undefined;
  const expired = Boolean(expiresAt && expiresAt <= Date.now());
  return {
    orderId: order.orderId,
    sku: order.sku,
    amount: order.amount,
    originalPrice: order.originalPrice,
    status: order.status,
    utrRef: order.utrRef,
    unlockCode: order.status === 'approved' && !expired ? order.unlockCode : undefined,
    rejectionReason: order.status === 'rejected' ? order.rejectionReason : undefined,
    createdAt: order.createdAt,
    verifiedAt: order.verifiedAt,
    expiresAt,
    expired,
  };
}

function notifyOrderWatchers(order: OverlayOrder) {
  const clients = orderSseClients.get(order.orderId);
  if (!clients || clients.size === 0) return;
  const payload = JSON.stringify({ order: toPublicOrderSummary(order) });
  for (const res of clients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}

function requireAdminPin(req: express.Request, res: express.Response): boolean {
  const provided = String(req.headers['x-admin-pin'] || '').trim();
  if (!provided || provided !== ADMIN_PIN) {
    res.status(401).json({ ok: false, error: 'Invalid owner verification PIN.' });
    return false;
  }
  return true;
}

async function startServer() {
  const app = express();
  // Allow up to 1.5MB for compressed payment screenshot proof
  app.use(express.json({ limit: '1.5mb' }));

  // Allow OBS / vMix local browser inputs to fetch state cleanly
  app.use('/api', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-pin');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // 1. Submit a ₹99 UPI payment proof -> creates PENDING order (NEVER auto-unlocks!)
  app.post('/api/overlay/orders', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const sku = String(body.sku || '').trim();
    const buyerName = String(body.buyerName || '').trim().slice(0, 80);
    const buyerPhone = String(body.buyerPhone || '').replace(/\D/g, '').slice(0, 15);
    const utrRef = String(body.utrRef || '').replace(/\D/g, '').slice(0, 12);
    const rawProof = typeof body.proofImage === 'string' ? body.proofImage : '';
    const proofImage =
      rawProof.startsWith('data:image/') && rawProof.length <= 900_000 ? rawProof : undefined;

    if (!VALID_SKUS.has(sku)) {
      res.status(400).json({ ok: false, error: 'Invalid overlay selection.' });
      return;
    }
    if (buyerName.length < 2) {
      res.status(400).json({ ok: false, error: 'Please enter your full name.' });
      return;
    }
    if (buyerPhone.length < 10) {
      res.status(400).json({ ok: false, error: 'Please enter a valid 10-digit mobile number.' });
      return;
    }
    if (!/^\d{12}$/.test(utrRef)) {
      res.status(400).json({
        ok: false,
        error: 'Please enter the exact 12-digit UPI UTR / Transaction Reference Number.',
      });
      return;
    }

    // Prevent reusing the same UTR across different orders (allow re-checking if same SKU & still pending)
    const duplicate = orders.find((o) => o.utrRef === utrRef && o.status !== 'rejected');
    if (duplicate) {
      if (duplicate.sku === sku && duplicate.buyerPhone === buyerPhone) {
        res.json({ ok: true, order: toPublicOrderSummary(duplicate), existing: true });
        return;
      }
      res.status(409).json({
        ok: false,
        error: 'This 12-digit UPI UTR has already been submitted for another order.',
      });
      return;
    }

    const order: OverlayOrder = {
      orderId: generateOrderId(),
      sku,
      amount: 99,
      originalPrice: 149,
      buyerName,
      buyerPhone,
      utrRef,
      proofImage,
      status: 'pending',
      createdAt: Date.now(),
    };

    orders.unshift(order);
    savePersistedOrders(orders);

    res.status(201).json({
      ok: true,
      order: toPublicOrderSummary(order),
    });
  });

  // 2. Poll current payment verification status of an order
  app.get('/api/overlay/orders/:orderId/status', (req, res) => {
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }
    res.json({ ok: true, order: toPublicOrderSummary(order) });
  });

  // 3. Real-time SSE stream for a buyer waiting on ₹99 payment confirmation
  app.get('/api/overlay/orders/:orderId/stream', (req, res) => {
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clients = orderSseClients.get(orderId);
    if (!clients) {
      clients = new Set();
      orderSseClients.set(orderId, clients);
    }
    clients.add(res);

    // Immediate snapshot
    res.write(`data: ${JSON.stringify({ order: toPublicOrderSummary(order) })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 20000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients?.delete(res);
    });
  });

  // 4. Verify an owner-issued Unlock Code (STAR-XXXX-XXXX) or approved Order ID (strict 24h validity)
  app.post('/api/overlay/verify-unlock', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const code = String(body.unlockCode || '').trim().toUpperCase();
    const requestedSku = String(body.sku || '').trim();

    if (!code) {
      res.status(400).json({ ok: false, error: 'Please enter your verified Unlock Code.' });
      return;
    }

    const match = orders.find(
      (o) =>
        o.status === 'approved' &&
        (o.unlockCode?.toUpperCase() === code || o.orderId.toUpperCase() === code) &&
        (!requestedSku || o.sku === requestedSku)
    );

    if (!match || !match.unlockCode) {
      res.status(403).json({
        ok: false,
        error:
          'Unlock code not found or ₹99 payment is not yet confirmed. Please verify payment first.',
      });
      return;
    }

    const expiresAt = getOrderExpiresAt(match);
    if (expiresAt <= Date.now()) {
      res.status(403).json({
        ok: false,
        expired: true,
        error:
          'This 24-hour overlay pass has expired and auto-locked. Please pay ₹99 again to unlock for 24 hours.',
      });
      return;
    }

    res.json({
      ok: true,
      sku: match.sku,
      orderId: match.orderId,
      unlockCode: match.unlockCode,
      expiresAt,
    });
  });

  // 5. Server-side validation of locally cached unlock tokens (auto-drops expired 24h tokens)
  app.post('/api/overlay/validate-tokens', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const tokens = Array.isArray(body.tokens) ? body.tokens : [];
    const now = Date.now();
    const verified: Array<{ sku: string; orderId: string; unlockCode: string; expiresAt: number }> =
      [];

    for (const item of tokens) {
      if (!item || typeof item !== 'object') continue;
      const sku = String(item.sku || '');
      const orderId = String(item.orderId || '').toUpperCase();
      const unlockCode = String(item.unlockCode || '').toUpperCase();
      const match = orders.find(
        (o) =>
          isOrderActive(o, now) &&
          o.sku === sku &&
          o.orderId === orderId &&
          o.unlockCode === unlockCode
      );
      if (match && match.unlockCode) {
        verified.push({
          sku: match.sku,
          orderId: match.orderId,
          unlockCode: match.unlockCode,
          expiresAt: getOrderExpiresAt(match),
        });
      }
    }

    res.json({ ok: true, verified });
  });

  // 5b. Live OBS / vMix Browser Source 24-hour access check
  app.get('/api/overlay/access', (req, res) => {
    const sku = String(req.query.sku || '').trim();
    const token = String(req.query.token || '').trim().toUpperCase();
    const now = Date.now();

    if (!token) {
      res.status(403).json({ ok: false, active: false, reason: 'missing_token' });
      return;
    }

    const match = orders.find(
      (o) =>
        o.status === 'approved' &&
        o.unlockCode?.toUpperCase() === token &&
        (!sku || o.sku === sku)
    );

    if (!match) {
      res.status(403).json({ ok: false, active: false, reason: 'invalid_token' });
      return;
    }

    const expiresAt = getOrderExpiresAt(match);
    if (expiresAt <= now) {
      res.status(403).json({ ok: false, active: false, reason: 'expired', expiresAt });
      return;
    }

    res.json({ ok: true, active: true, sku: match.sku, expiresAt });
  });

  // 6. Owner Admin: list all ₹99 payment verification requests with 24h expiry metadata
  app.get('/api/admin/orders', (req, res) => {
    if (!requireAdminPin(req, res)) return;
    const now = Date.now();
    const enriched = orders.map((o) => {
      const expiresAt = o.status === 'approved' ? getOrderExpiresAt(o) : undefined;
      return {
        ...o,
        expiresAt,
        isExpired: Boolean(expiresAt && expiresAt <= now),
      };
    });
    res.json({ ok: true, orders: enriched });
  });

  // 7. Owner Admin: approve ₹99 payment -> starts 24-hour unlock window & pushes live over SSE
  app.post('/api/admin/orders/:orderId/approve', (req, res) => {
    if (!requireAdminPin(req, res)) return;
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }

    const now = Date.now();
    order.status = 'approved';
    order.unlockCode = order.unlockCode || generateUnlockCode();
    order.rejectionReason = undefined;
    order.verifiedAt = now;
    order.expiresAt = now + UNLOCK_DURATION_MS;
    savePersistedOrders(orders);
    notifyOrderWatchers(order);

    res.json({
      ok: true,
      order: {
        ...order,
        isExpired: false,
      },
    });
  });

  // 8. Owner Admin: reject unpaid / invalid UTR request
  app.post('/api/admin/orders/:orderId/reject', (req, res) => {
    if (!requireAdminPin(req, res)) return;
    const orderId = String(req.params.orderId || '').trim().toUpperCase();
    const order = orders.find((o) => o.orderId === orderId);
    if (!order) {
      res.status(404).json({ ok: false, error: 'Order not found.' });
      return;
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 140);
    order.status = 'rejected';
    order.unlockCode = undefined;
    order.rejectionReason =
      reason || '₹99 payment not received for this UTR. Please check and resubmit.';
    order.verifiedAt = Date.now();
    savePersistedOrders(orders);
    notifyOrderWatchers(order);

    res.json({ ok: true, order });
  });

  // Get current room state
  app.get('/api/overlay/:roomId', (req, res) => {
    const roomId = sanitizeRoomId(req.params.roomId);
    const state = getOrCreateRoom(roomId);
    const connectedDisplays = sseClients.get(roomId)?.size ?? 0;
    res.json({ state, connectedDisplays });
  });

  // Update room state & broadcast to all connected OBS/vMix browser sources
  app.post('/api/overlay/:roomId', (req, res) => {
    const roomId = sanitizeRoomId(req.params.roomId);
    const current = getOrCreateRoom(roomId);
    const patch = req.body && typeof req.body === 'object' ? req.body : {};

    const nextState: LiveOverlayState = {
      ...current,
      ...patch,
      roomId,
      updatedAt: Date.now(),
    };

    rooms.set(roomId, nextState);
    broadcastRoomState(roomId, nextState);

    const connectedDisplays = sseClients.get(roomId)?.size ?? 0;
    res.json({ state: nextState, connectedDisplays });
  });

  // Real-time Server-Sent Events stream for OBS / vMix Browser Sources & Control Desks
  app.get('/api/overlay/:roomId/stream', (req, res) => {
    const roomId = sanitizeRoomId(req.params.roomId);
    const state = getOrCreateRoom(roomId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let clients = sseClients.get(roomId);
    if (!clients) {
      clients = new Set();
      sseClients.set(roomId, clients);
    }
    clients.add(res);

    // Push immediate initial snapshot + updated connected display count
    broadcastRoomState(roomId, state);

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(heartbeat);
      clients?.delete(res);
      if (clients && clients.size > 0) {
        broadcastRoomState(roomId, getOrCreateRoom(roomId));
      }
    });
  });

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Star Event Live server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
