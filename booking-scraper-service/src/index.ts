import express, { type Request, type Response, type NextFunction } from "express";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  createBookingSession,
  describeAuthState,
  ensureBookingAuthenticated,
  persistCookies,
  scrapeBookingReviews,
  scrapeReviewsWithSession,
  submitTwoFactorCode,
  requestTwoFactorCode,
  selectPhoneOption,
  selectTwoFactorMethod,
  extractPhoneOptions,
  checkExistingBookingSession,
  loadPersistedSession,
  savePersistedSession,
  storePersistedSession,
  deletePersistedSession,
  getSessionStatus,
  saveScreenshot,
  type BookingSession,
  type AuthCheckResult,
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
  {
    session: BookingSession;
    expiresAt: number;
    status: "waiting_2fa";
    selectedMethod?: "sms" | "call";
    twoFactorType?: "phone" | "email";
  }
>();

const SESSION_TTL_MS = 5 * 60 * 1000;
let lastTwoFactorScreenshotPath: string | null = null;
let lastLoginScreenshotPath: string | null = null;

async function logAuthState(page: BookingSession["page"], contextLabel: string) {
  const state = await describeAuthState(page);
  console.log(
    `[SCRAPER] ${contextLabel} | state=${state.state} | title=${state.title} | url=${state.url}`
  );
  return state;
}

function mapStateToTwoFactorType(state: string): "phone" | "email" {
  return state === "two_factor_email" ? "email" : "phone";
}

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

app.post("/session/:companyId", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();
  const { cookies, storageState } = req.body || {};

  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  if (!Array.isArray(cookies) && !storageState) {
    return res.status(400).json({ success: false, error: "cookies o storageState requeridos" });
  }

  try {
    await storePersistedSession(companyId, { cookies, storageState });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "No se pudo guardar la sesión" });
  }
});

app.post("/session/:companyId/validate", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();

  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  try {
    const session = await createBookingSession(companyId);
    try {
      const authState = await checkExistingBookingSession(session);
      res.json({ success: authState.result === "ok", authState: authState.result, url: authState.url, title: authState.title });
    } finally {
      await session.context.close().catch(() => undefined);
      await session.browser.close().catch(() => undefined);
    }
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "No se pudo validar la sesión" });
  }
});

app.get("/session/:companyId/status", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();

  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  try {
    const status = await getSessionStatus(companyId);
    res.json({ success: true, ...status });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "No se pudo consultar la sesión" });
  }
});

app.delete("/session/:companyId", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();

  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  try {
    await deletePersistedSession(companyId);
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ success: false, error: error?.message || "No se pudo borrar la sesión" });
  }
});

app.get("/debug/last-2fa-screenshot", requireApiKey, async (_req, res) => {
  try {
    let screenshotPath: string | null = lastTwoFactorScreenshotPath;
    if (!screenshotPath) {
      const candidates = [
        "/tmp/booking-post-otp-2fa-last.txt",
        "/tmp/booking-post-otp-state-last.txt",
        "/tmp/booking-before-export-last.txt",
        "/tmp/booking-reviews-missing-export-last.txt",
        "/tmp/booking-2fa-last.txt",
      ];
      for (const candidate of candidates) {
        const resolved = (await fs.readFile(candidate, "utf8").catch(() => "")).trim();
        if (resolved) {
          screenshotPath = resolved;
          break;
        }
      }
    }
    if (!screenshotPath) {
      return res.status(404).json({
        success: false,
        error: "No hay captura 2FA disponible",
      });
    }
    const data = await fs.readFile(screenshotPath);
    res.json({
      success: true,
      path: screenshotPath,
      contentType: "image/png",
      base64: data.toString("base64"),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message || "No se pudo leer la captura",
    });
  }
});

app.get("/debug/last-login-screenshot", requireApiKey, async (_req, res) => {
  try {
    let screenshotPath: string | null = lastLoginScreenshotPath;
    if (!screenshotPath) {
      const candidates = [
        "/tmp/booking-login-security-check-last.txt",
        "/tmp/booking-login-invalid-last.txt",
        "/tmp/booking-login-last.txt",
      ];
      for (const candidate of candidates) {
        const resolved = (await fs.readFile(candidate, "utf8").catch(() => "")).trim();
        if (resolved) {
          screenshotPath = resolved;
          break;
        }
      }
    }
    if (!screenshotPath) {
      return res.status(404).json({
        success: false,
        error: "No hay captura de login disponible",
      });
    }
    const data = await fs.readFile(screenshotPath);
    res.json({
      success: true,
      path: screenshotPath,
      contentType: "image/png",
      base64: data.toString("base64"),
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error?.message || "No se pudo leer la captura de login",
    });
  }
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
      try {
        const existingSession = await checkExistingBookingSession(session);

        if (existingSession.result === "ok") {
          const scrapeResult = await scrapeReviewsWithSession(session);
          await savePersistedSession(session.context, companyId, "storageState");
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
          return { type: "result", data: scrapeResult } as const;
        }

        if (existingSession.result === "security_block") {
          await saveScreenshot(session.page, companyId, "security-block");
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
          throw new Error("BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA");
        }

        if (String(process.env.BOOKING_ENABLE_AUTOMATED_LOGIN || "true").toLowerCase() === "false") {
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
          throw new Error(
            existingSession.result === "login_required"
              ? "BOOKING_SESSION_EXPIRED"
              : "BOOKING_MANUAL_REAUTH_REQUIRED"
          );
        }

        const authStatus = await ensureBookingAuthenticated(session);
        const isTwoFactor = typeof authStatus === "object" && authStatus.status === "2fa_required";
        if (isTwoFactor) {
          const authState = await logAuthState(session.page, "2FA session created");
          const sessionId = randomUUID();
          const expiresAt = Date.now() + SESSION_TTL_MS;
          const twoFactorType = authStatus.twoFactorType || mapStateToTwoFactorType(authState.state);
          twoFactorSessions.set(sessionId, {
            session,
            expiresAt,
            status: "waiting_2fa",
            twoFactorType,
          });
          return {
            type: "two_factor",
            sessionId,
            expiresAt,
            phoneOptions: authStatus.phoneOptions || [],
            twoFactorType,
            authState,
          } as const;
        }

        if (authStatus !== "ok") {
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
          return { type: "error", status: authStatus } as const;
        }

        const scrapeResult = await scrapeReviewsWithSession(session);
        await savePersistedSession(session.context, companyId, "storageState");
        await session.context.close().catch(() => undefined);
        await session.browser.close().catch(() => undefined);
        return { type: "result", data: scrapeResult } as const;
      } catch (error) {
        if (!twoFactorSessions || !Array.from(twoFactorSessions.values()).some((entry) => entry.session === session)) {
          await session.context.close().catch(() => undefined);
          await session.browser.close().catch(() => undefined);
        }
        throw error;
      }
    });

    const duration = Date.now() - startTime;
    if (result.type === "two_factor") {
      console.log(`[SCRAPER] Two-factor required for ${companyId}`);
      return res.status(202).json({
        success: false,
        requiresTwoFactor: true,
        sessionId: result.sessionId,
        expiresAt: result.expiresAt,
        phoneOptions: result.phoneOptions,
        twoFactorType: result.twoFactorType,
        authState: result.authState,
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
        : message === "BOOKING_AUTH_CONTEXT_NOT_READY_FOR_REVIEWS"
        ? 409
        : message === "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
        ? 503
        : message === "BOOKING_SESSION_MISSING"
        ? 409
        : message === "BOOKING_SESSION_EXPIRED"
        ? 401
        : message === "BOOKING_MANUAL_REAUTH_REQUIRED"
        ? 409
        : message === "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR"
        ? 502
        : 500;

    console.error("[SCRAPER] Error en /scrape:", error);
    res.status(status).json({ success: false, error: message });
  }
});

app.post(
  "/scrape/:companyId/send-2fa",
  requireApiKey,
  async (req: Request, res: Response) => {
    const companyId = (req.params.companyId || "").trim();
    const { sessionId, phoneLabel } = req.body || {};

    if (!companyId || !sessionId) {
      return res.status(400).json({
        success: false,
        error: "sessionId es requerido",
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

    if (!entry.selectedMethod) {
      return res.status(400).json({
        success: false,
        error: "Debe seleccionar el método antes de enviar el código",
      });
    }

    try {
      const state = await logAuthState(entry.session.page, "Before send-2fa");
      if (state.state !== "two_factor") {
        if (state.state === "two_factor_email") {
          entry.twoFactorType = "email";
          return res.status(409).json({
            success: false,
            error: "EMAIL_CODE_REQUIRED",
            twoFactorType: "email",
            authState: state,
          });
        }
        return res.status(409).json({
          success: false,
          error: "2FA_NOT_READY",
          state: state.state,
          url: state.url,
          title: state.title,
        });
      }

      if (entry.twoFactorType === "email") {
        return res.status(409).json({
          success: false,
          error: "EMAIL_CODE_REQUIRED",
          twoFactorType: "email",
          authState: state,
        });
      }
      if (phoneLabel) {
        await selectPhoneOption(entry.session.page, phoneLabel);
      }
      await requestTwoFactorCode(entry.session.page, entry.selectedMethod);
      await entry.session.page.waitForTimeout(2000);
      res.json({ success: true, message: "Código enviado" });
    } catch (error: any) {
      console.error("[SCRAPER] Error en /send-2fa:", error);
      res.status(500).json({
        success: false,
        error: error?.message || "Error al enviar código 2FA",
      });
    }
  }
);

app.post(
  "/scrape/:companyId/select-2fa-method",
  requireApiKey,
  async (req: Request, res: Response) => {
    const companyId = (req.params.companyId || "").trim();
    const { sessionId, method } = req.body || {};

    if (!companyId || !sessionId || !method) {
      return res.status(400).json({
        success: false,
        error: "sessionId y method son requeridos",
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
      let state = await logAuthState(entry.session.page, "Before select-2fa-method");
      if (state.state === "two_factor_email") {
        entry.twoFactorType = "email";
        return res.status(409).json({
          success: false,
          error: "EMAIL_CODE_REQUIRED",
          twoFactorType: "email",
          authState: state,
        });
      }
      if (state.state !== "two_factor") {
        for (let i = 0; i < 5; i++) {
          await entry.session.page.waitForTimeout(1000);
          state = await logAuthState(entry.session.page, `Waiting 2FA (${i + 1}/5)`);
          if (state.state === "two_factor" || state.state === "two_factor_email") break;
        }
      }

      if (state.state !== "two_factor") {
        if (state.state === "two_factor_email") {
          entry.twoFactorType = "email";
          return res.status(409).json({
            success: false,
            error: "EMAIL_CODE_REQUIRED",
            twoFactorType: "email",
            authState: state,
          });
        }
        return res.status(409).json({
          success: false,
          error: "2FA_NOT_READY",
          state: state.state,
          url: state.url,
          title: state.title,
        });
      }

      const normalizedMethod = method === "call" ? "call" : "sms";
      await selectTwoFactorMethod(entry.session.page, normalizedMethod);
      entry.selectedMethod = normalizedMethod;
      await entry.session.page
        .waitForFunction(
          () => {
            const hasSelect = Boolean(document.querySelector("select"));
            const hasPhoneLabel = Array.from(document.querySelectorAll("label, div, span, p"))
              .map((el) => (el.textContent || "").toLowerCase())
              .some((text) => text.includes("número de teléfono") || text.includes("phone number"));
            const hasSendButton = Array.from(document.querySelectorAll("button, a"))
              .map((el) => (el.textContent || "").toLowerCase())
              .some((text) => text.includes("enviar código") || text.includes("send verification"));
            return hasSelect || hasPhoneLabel || hasSendButton;
          },
          { timeout: 10000 }
        )
        .catch(() => undefined);
      const phoneOptions = await extractPhoneOptions(entry.session.page);
      console.log(
        `[SCRAPER] 2FA method confirmed (${normalizedMethod}). Phone options: ${phoneOptions.length}`
      );
      if (phoneOptions.length === 0) {
        const stateAfter = await logAuthState(entry.session.page, "After select-2fa-method");
        const path = `/tmp/booking-2fa-no-phones-${Date.now()}.png`;
        await entry.session.page.screenshot({ path, fullPage: true }).catch(() => undefined);
        lastTwoFactorScreenshotPath = path;
        console.log(`[SCRAPER] Saved 2FA screenshot: ${path}`);
        console.log(
          `[SCRAPER] No phones after method. state=${stateAfter.state} url=${stateAfter.url}`
        );
      }
      res.json({
        success: true,
        phoneOptions,
        authState: { state: state.state, url: state.url, title: state.title },
        twoFactorType: entry.twoFactorType || "phone",
      });
    } catch (error: any) {
      console.error("[SCRAPER] Error en /select-2fa-method:", error);
      res.status(500).json({
        success: false,
        error: error?.message || "Error al seleccionar método 2FA",
      });
    }
  }
);

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
        const status = await submitTwoFactorCode(
          entry.session,
          String(code)
        );
        if (status === "invalid_code") {
          return { type: "invalid", status } as const;
        }

        const authStatus = await ensureBookingAuthenticated(entry.session);
        if (typeof authStatus === "object" && authStatus.status === "2fa_required") {
          const authState = await logAuthState(entry.session.page, "2FA required after verify-2fa");
          entry.expiresAt = Date.now() + SESSION_TTL_MS;
          entry.selectedMethod = undefined;
          entry.twoFactorType = authStatus.twoFactorType;
          return {
            type: "two_factor",
            sessionId,
            expiresAt: entry.expiresAt,
            phoneOptions: authStatus.phoneOptions || [],
            twoFactorType: authStatus.twoFactorType,
            authState,
          } as const;
        }

        if (authStatus !== "ok") {
          return { type: "auth_error", status: authStatus } as const;
        }

        const scrapeResult = await scrapeReviewsWithSession(entry.session);
        await savePersistedSession(entry.session.context, companyId, "storageState");
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

      if (result.type === "two_factor") {
        return res.status(202).json({
          success: false,
          requiresTwoFactor: true,
          sessionId: result.sessionId,
          expiresAt: result.expiresAt,
          phoneOptions: result.phoneOptions,
          twoFactorType: result.twoFactorType,
          authState: result.authState,
        });
      }

      if (result.type === "auth_error") {
        const message =
          result.status === "invalid_credentials"
            ? "BOOKING_AUTH_INVALID_CREDENTIALS"
            : result.status === "security_block"
            ? "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
            : "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR";
        throw new Error(message);
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
