import { Router, type IRouter } from "express";
import { pool } from "../lib/db";
import { hashPin, verifyPin, isHashed } from "../lib/hash";

const router: IRouter = Router();
const DEFAULT_MASTER_PIN = "master1234";

async function getStoredMasterPin(): Promise<string> {
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'master_pin'`,
  );
  return r.rows[0]?.value ?? DEFAULT_MASTER_PIN;
}

async function setMasterPinHash(plain: string): Promise<void> {
  const hashed = hashPin(plain);
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('master_pin', $1) ON CONFLICT (key) DO UPDATE SET value = $1`,
    [hashed],
  );
}

router.post("/admin/verify-master-pin", async (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!pin) { res.status(400).json({ error: "PIN required" }); return; }
  const stored = await getStoredMasterPin();
  if (!verifyPin(pin, stored)) { res.status(401).json({ error: "Wrong Master PIN" }); return; }
  // Migrate legacy plain-text master PIN to hash on successful login
  if (!isHashed(stored)) {
    await setMasterPinHash(pin);
  }
  res.json({ ok: true });
});

router.patch("/admin/master-pin", async (req, res) => {
  const { currentPin, newPin } = req.body as { currentPin?: string; newPin?: string };
  if (!currentPin || !newPin) { res.status(400).json({ error: "currentPin and newPin required" }); return; }
  if (newPin.length < 4) { res.status(400).json({ error: "PIN must be at least 4 characters" }); return; }
  const stored = await getStoredMasterPin();
  if (!verifyPin(currentPin, stored)) { res.status(401).json({ error: "Current PIN is wrong" }); return; }
  await setMasterPinHash(newPin);
  res.json({ ok: true });
});

export default router;
