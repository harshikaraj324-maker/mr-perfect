import { Router, type IRouter } from "express";
import { DEFAULT_APP_ID, localDb } from "../lib/local-db";

const router: IRouter = Router();
const VALIDITY_DAYS = 30;

function isExpired(createdAt: string | Date): boolean {
  const created = new Date(createdAt).getTime();
  const expiry = created + VALIDITY_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() > expiry;
}

async function autoDisableIfExpired(appId: string): Promise<void> {
  const app = await localDb.getApp(appId);
  if (app?.appId === DEFAULT_APP_ID) {
    await localDb.updateApp(appId, { status: "active" });
    return;
  }
  if (app && app.status === "active" && isExpired(app.createdAt)) {
    await localDb.updateApp(appId, { status: "disabled" });
  }
}

router.get("/apps", async (_req, res) => {
  const rows = await localDb.listApps();
  for (const app of rows) {
    if (app.appId === DEFAULT_APP_ID) {
      await localDb.updateApp(app.appId, { status: "active" });
    } else if (app.status === "active" && isExpired(app.createdAt)) {
      await localDb.updateApp(app.appId, { status: "disabled" });
    }
  }
  res.json(await localDb.listApps());
});

router.get("/apps/:appId", async (req, res) => {
  await autoDisableIfExpired(req.params.appId);
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  res.json(app);
});

router.post("/apps", async (req, res) => {
  const { appId, name, pin, status } = req.body as { appId?: string; name?: string; pin?: string; status?: string };
  if (!appId || !name) { res.status(400).json({ error: "appId and name are required" }); return; }
  if (name.trim() !== "MR ROBOT") { res.status(400).json({ error: "App name must be 'MR ROBOT'" }); return; }
  try {
    const row = await localDb.createApp({ appId, name: "MR ROBOT", pin, status });
    res.status(201).json(row);
  } catch (err) {
    if ((err as Error).message === "APP_EXISTS") { res.status(409).json({ error: "App ID already exists" }); return; }
    throw err;
  }
});

router.patch("/apps/:appId", async (req, res) => {
  const { name, pin, status } = req.body as { name?: string; pin?: string; status?: string };
  const updates: { name?: string; pin?: string; status?: string } = {};
  if (name !== undefined) updates.name = name;
  if (pin !== undefined) updates.pin = pin;
  if (status !== undefined) updates.status = status;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields to update" }); return; }
  const row = await localDb.updateApp(req.params.appId, updates);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json(row);
});

router.delete("/apps/:appId", async (req, res) => {
  const row = await localDb.deleteApp(req.params.appId);
  if (!row) { res.status(404).json({ error: "App not found" }); return; }
  res.json({ ok: true });
});

router.post("/apps/:appId/verify-pin", async (req, res) => {
  const { pin } = req.body as { pin?: string };
  if (!pin) { res.status(400).json({ error: "PIN required" }); return; }
  await autoDisableIfExpired(req.params.appId);
  const app = await localDb.getApp(req.params.appId);
  if (!app) { res.status(404).json({ error: "App not found" }); return; }
  if (app.status !== "active") { res.status(403).json({ error: "App is disabled" }); return; }
  const verified = await localDb.verifyAppPin(req.params.appId, pin);
  if (!verified) { res.status(401).json({ error: "Wrong PIN" }); return; }
  res.json({ ok: true, appId: verified.appId, name: verified.name });
});

export default router;
