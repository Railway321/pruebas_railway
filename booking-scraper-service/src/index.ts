import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import {
  createBookingSession,
  ensureBookingAuthenticated,
  persistCookies,
  scrapeReviewsWithSession,
  submitTwoFactorCode,
  type BookingSession,
} from "./booking-scraper.js";

const app = express();
app.use(express.json());

const requiredApiKey = process.env.SCRAPER_API_KEY;
if (!requiredApiKey) {
  console.warn("[SCRAPER] ⚠️ SCRAPER_API_KEY no está configurada");
}

const locks = new Set<string>();
const twoFactorSessions = new Map<
  string,
  { session: BookingSession; expiresAt: number; status: "waiting_2fa" }
>();

const SESSION_TTL_MS = 5 * 60 * 1000;

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!requiredApiKey) {
    return res.status(500).json({ success: false, error: "SCRAPER_API_KEY missing" });
  }

  const header = req.header("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || token !== requiredApiKey) {
    return res.status(401).json({ success: false, error: "Unauthorized" });
  }
  next();
}

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(key)) {
    throw new Error("SCRAPER_ALREADY_RUNNING");
  }
  locks.add(key);
  try {
    return await fn();
  } finally {
    locks.delete(key);
  }
}

function cleanupExpiredSessions() {
  const now = Date.now();
  for (const [sessionId, entry] of twoFactorSessions.entries()) {
    if (entry.expiresAt <= now) {
      entry.session.browser.close().catch(() => undefined);
      twoFactorSessions.delete(sessionId);
    }
  }
}

setInterval(cleanupExpiredSessions, 60 * 1000).unref();

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/scrape/:companyId", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();
  console.log(`[SCRAPER] Received scrape request for company: ${companyId}`);
  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  try {
    console.log(`[SCRAPER] Starting scrape for company: ${companyId}`);
    const startTime = Date.now();
    const result = await withLock(companyId, async () => {
      const session = await createBookingSession(companyId);
      const authStatus = await ensureBookingAuthenticated(session);

      if (authStatus === "2fa_required") {
        const sessionId = randomUUID();
        const expiresAt = Date.now() + SESSION_TTL_MS;
        twoFactorSessions.set(sessionId, {
          session,
          expiresAt,
          status: "waiting_2fa",
        });
        return {
          type: "two_factor",
          sessionId,
          expiresAt,
        } as const;
      }

      if (authStatus !== "ok") {
        await session.browser.close();
        return { type: "error", status: authStatus } as const;
      }

      const scrapeResult = await scrapeReviewsWithSession(session);
      await persistCookies(session);
      await session.context.close();
      await session.browser.close();
      return { type: "result", data: scrapeResult } as const;
    });

    const duration = Date.now() - startTime;
    if (result.type === "two_factor") {
      console.log(`[SCRAPER] Two-factor required for ${companyId}`);
      return res.status(202).json({
        success: false,
        requiresTwoFactor: true,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
      });
    }

    if (result.type === "error") {
      const message =
        result.status === "invalid_credentials"
          ? "BOOKING_AUTH_INVALID_CREDENTIALS"
          : result.status === "security_block"
          ? "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
          : result.status === "unknown"
          ? "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR"
          : "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR";
      throw new Error(message);
    }

    console.log(
      `[SCRAPER] Scraping completed in ${duration}ms. Reviews: ${result.data.reviews.length}, Errors: ${result.data.errors.length}`
    );
    res.json({ success: true, data: result.data });
  } catch (error: any) {
    const message = error?.message || "Error desconocido";
    console.error(`[SCRAPER] Scraping failed: ${message}`);
    const status =
      message === "SCRAPER_ALREADY_RUNNING"
        ? 409
        : message === "BOOKING_AUTH_INVALID_CREDENTIALS"
        ? 401
        : message === "BOOKING_AUTH_2FA_REQUIRED"
        ? 401
        : message === "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
        ? 503
        : message === "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR"
        ? 502
        : 500;

    console.error("[SCRAPER] Error en /scrape:", error);
    res.status(status).json({ success: false, error: message });
  }
});

app.post(
  "/scrape/:companyId/verify-2fa",
  requireApiKey,
  async (req: Request, res: Response) => {
    const companyId = (req.params.companyId || "").trim();
    const { sessionId, code } = req.body || {};

    if (!companyId || !sessionId || !code) {
      return res.status(400).json({
        success: false,
        error: "sessionId y code son requeridos",
      });
    }

    const entry = twoFactorSessions.get(sessionId);
    if (!entry || entry.session.companyId !== companyId) {
      return res.status(404).json({
        success: false,
        error: "Sesion 2FA no encontrada o expirada",
      });
    }

    if (entry.expiresAt <= Date.now()) {
      entry.session.browser.close().catch(() => undefined);
      twoFactorSessions.delete(sessionId);
      return res.status(410).json({
        success: false,
        error: "Sesion 2FA expirada",
      });
    }

    try {
      const result = await withLock(companyId, async () => {
        const status = await submitTwoFactorCode(entry.session, String(code));
        if (status !== "ok") {
          return { type: "invalid", status } as const;
        }

        const scrapeResult = await scrapeReviewsWithSession(entry.session);
        await persistCookies(entry.session);
        await entry.session.context.close();
        await entry.session.browser.close();
        twoFactorSessions.delete(sessionId);
        return { type: "result", data: scrapeResult } as const;
      });

      if (result.type === "invalid") {
        return res.status(401).json({
          success: false,
          error: "Codigo 2FA inválido",
          retriable: true,
        });
      }

      res.json({ success: true, data: result.data });
    } catch (error: any) {
      console.error("[SCRAPER] Error en /verify-2fa:", error);
      res.status(500).json({
        success: false,
        error: error?.message || "Error al validar 2FA",
      });
    }
  }
);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[SCRAPER] Servicio escuchando en puerto ${port}`);
});

process.on("unhandledRejection", (reason) => {
  console.error("[SCRAPER] Unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
  console.error("[SCRAPER] Uncaught exception", error);
});
