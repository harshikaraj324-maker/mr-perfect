import type { Request, Response, NextFunction } from "express";
  import { env } from "../lib/env";

  /**
   * Validates X-App-Secret header on Android-only routes.
   * Requests without a valid secret receive 403 — the actual
   * backend URL is never exposed to the caller.
   *
   * Set APP_SECRET env var on the server.
   * Android app must send:  X-App-Secret: <same value>
   */
  export function requireAppSecret(req: Request, res: Response, next: NextFunction): void {
    if (!env.appSecret) {
      // Secret not configured — skip check (dev/fallback mode)
      next();
      return;
    }

    const header = req.headers["x-app-secret"];
    if (!header || header !== env.appSecret) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    next();
  }
  