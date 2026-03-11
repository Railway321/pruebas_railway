import express, { type Request, type Response, type NextFunction } from "express";
import { scrapeBookingReviews } from "./booking-scraper.js";

const app = express();
app.use(express.json());

const requiredApiKey = process.env.SCRAPER_API_KEY;
if (!requiredApiKey) {
  console.warn("[SCRAPER] ⚠️ SCRAPER_API_KEY no está configurada");
}

const locks = new Set<string>();

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

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

app.post("/scrape/:companyId", requireApiKey, async (req: Request, res: Response) => {
  const companyId = (req.params.companyId || "").trim();
  if (!companyId) {
    return res.status(400).json({ success: false, error: "companyId requerido" });
  }

  try {
    const result = await withLock(companyId, () => scrapeBookingReviews(companyId));
    res.json({ success: true, data: result });
  } catch (error: any) {
    const message = error?.message || "Error desconocido";
    const status =
      message === "SCRAPER_ALREADY_RUNNING"
        ? 409
        : message === "BOOKING_AUTH_INVALID_CREDENTIALS"
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
