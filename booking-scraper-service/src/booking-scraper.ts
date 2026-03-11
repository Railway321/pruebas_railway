import { chromium, type BrowserContext } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { parseBookingCsv, type InsertReview } from "./booking-csv-parser.js";

const COOKIE_DIR = process.env.BOOKING_COOKIES_DIR || path.join(process.cwd(), "cookies");

function getEnvOrThrow(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Configurar variable ${name} en Railway`);
  }
  return value;
}

async function ensureCookieDir() {
  await fs.mkdir(COOKIE_DIR, { recursive: true });
}

function getCookiesPath(companyId: string): string {
  return path.join(COOKIE_DIR, `booking-cookies-${companyId}.json`);
}

async function loadCookies(context: BrowserContext, companyId: string) {
  try {
    await ensureCookieDir();
    const data = await fs.readFile(getCookiesPath(companyId), "utf8");
    const cookies = JSON.parse(data);
    if (Array.isArray(cookies) && cookies.length > 0) {
      await context.addCookies(cookies);
    }
  } catch {
    // Primera ejecución: continuar sin error
  }
}

async function saveCookies(context: BrowserContext, companyId: string) {
  try {
    await ensureCookieDir();
    const cookies = await context.cookies();
    await fs.writeFile(
      getCookiesPath(companyId),
      JSON.stringify(cookies, null, 2),
      "utf8"
    );
  } catch (error) {
    console.warn("[SCRAPER] No se pudieron guardar las cookies:", error);
  }
}

function randomDelay(minMs = 8000, maxMs = 15000): number {
  const diff = maxMs - minMs;
  return minMs + Math.floor(Math.random() * diff);
}

function getUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

async function randomScroll(page: any) {
  const scrolls = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < scrolls; i++) {
    const scrollAmount = Math.floor(Math.random() * 500) + 100;
    await page.evaluate((y: number) => window.scrollBy(0, y), scrollAmount);
    await page.waitForTimeout(Math.random() * 1000 + 500);
  }
}

async function humanDelay(page: any, minMs = 3000, maxMs = 6000) {
  const delay = minMs + Math.floor(Math.random() * (maxMs - minMs));
  await page.waitForTimeout(delay);
}

export interface ScrapeResult {
  reviews: InsertReview[];
  errors: string[];
}

export async function scrapeBookingReviews(companyId: string): Promise<ScrapeResult> {
  console.log("[SCRAPER] Iniciando proceso para company:", companyId);

  const username = getEnvOrThrow("BOOKING_EXTRANET_USERNAME");
  const password = getEnvOrThrow("BOOKING_EXTRANET_PASSWORD");
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const loginUrl = getEnvOrThrow("BOOKING_LOGIN_URL");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--no-sandbox",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      "--window-size=1920,1080",
      "--start-maximized",
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: getUserAgent(),
      viewport: { width: 1920, height: 1080 },
      locale: "es-ES",
      timezoneId: "Europe/Madrid",
      permissions: ["geolocation"],
    });

    await loadCookies(context, companyId);
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });

    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page);
    await randomScroll(page);

    if (page.url().startsWith(loginUrl)) {
      await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
      await humanDelay(page);
      await randomScroll(page);

      const usernameSelector = 'input[name="username"], input[type="email"]';
      const passwordSelector = 'input[type="password"]';
      const submitSelector = 'button[type="submit"], button[data-ga-label="login-button"]';

      const usernameInput = await page.$(usernameSelector);
      const passwordInput = await page.$(passwordSelector);
      const submitButton = await page.$(submitSelector);

      if (!usernameInput || !passwordInput || !submitButton) {
        throw new Error("No se encontraron los campos de login de Booking");
      }

      for (const char of username) {
        await usernameInput.type(char, { delay: Math.random() * 100 + 50 });
      }
      await humanDelay(page);

      for (const char of password) {
        await passwordInput.type(char, { delay: Math.random() * 100 + 50 });
      }
      await humanDelay(page);
      await submitButton.click();

      await humanDelay(page, 5000, 8000);
      await randomScroll(page);

      if (page.url().startsWith(loginUrl)) {
        const bodyTextRaw = (await page.textContent("body")) || "";
        const bodyText = bodyTextRaw.toLowerCase();

        if (
          bodyText.includes("incorrect") ||
          bodyText.includes("wrong password") ||
          bodyText.includes("credentials") ||
          bodyText.includes("usuario")
        ) {
          throw new Error("BOOKING_AUTH_INVALID_CREDENTIALS");
        }

        if (
          bodyText.includes("unusual activity") ||
          bodyText.includes("captcha") ||
          bodyText.includes("blocked")
        ) {
          throw new Error("BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA");
        }

        throw new Error("BOOKING_AUTH_UNKNOWN_LOGIN_ERROR");
      }

      await saveCookies(context, companyId);
    }

    await page.goto(`${baseUrl}/reviews`, { waitUntil: "networkidle" });
    await humanDelay(page);
    await randomScroll(page);

    const exportButton =
      (await page.$('text="Exportar"')) ||
      (await page.$('text="Export"')) ||
      (await page.$('button:has-text("Export")'));

    if (!exportButton) {
      throw new Error("Botón de exportación de reseñas no encontrado en Booking");
    }

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 60000 }),
      exportButton.click(),
    ]);

    const stream = await download.createReadStream();
    if (!stream) {
      throw new Error("No se pudo leer el archivo CSV descargado");
    }

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    const csvBuffer = Buffer.concat(chunks);

    const { rows, errors } = await parseBookingCsv(csvBuffer);

    if (!rows.length) {
      if (errors.length) {
        throw new Error(errors[0]);
      }
      throw new Error("CSV vacío o sin reseñas nuevas para importar");
    }

    return {
      reviews: rows,
      errors,
    };
  } finally {
    await browser.close();
  }
}
