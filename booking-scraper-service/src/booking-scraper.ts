import { chromium, type BrowserContext, type Page } from "playwright";
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
    const envCookies = process.env.BOOKING_COOKIES_JSON;
    if (envCookies) {
      const parsed = JSON.parse(envCookies);
      const rawCookies = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : [];
      const normalized = rawCookies
        .map((cookie: any) => {
          if (!cookie || !cookie.name || !cookie.value) return null;

          const sameSiteMap: Record<string, "Strict" | "Lax" | "None"> = {
            strict: "Strict",
            lax: "Lax",
            none: "None",
            no_restriction: "None",
          };

          const expires =
            typeof cookie.expires === "number"
              ? cookie.expires
              : typeof cookie.expirationDate === "number"
              ? cookie.expirationDate
              : undefined;

          const sameSiteRaw = typeof cookie.sameSite === "string" ? cookie.sameSite.toLowerCase() : "";

          return {
            name: String(cookie.name),
            value: String(cookie.value),
            domain: cookie.domain || cookie.host || undefined,
            path: cookie.path || "/",
            expires,
            httpOnly: Boolean(cookie.httpOnly),
            secure: Boolean(cookie.secure),
            sameSite: sameSiteMap[sameSiteRaw],
          };
        })
        .filter(Boolean);

      if (normalized.length > 0) {
        await context.addCookies(normalized as any);
        console.log(`[SCRAPER] Loaded ${normalized.length} cookies from BOOKING_COOKIES_JSON`);
        return;
      }
    }

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

export interface BookingSession {
  companyId: string;
  browser: Awaited<ReturnType<typeof chromium.launch>>;
  context: BrowserContext;
  page: Page;
}

export type AuthStatus =
  | "ok"
  | "2fa_required"
  | "invalid_credentials"
  | "security_block"
  | "unknown";

export type TwoFactorStatus = "ok" | "invalid_code" | "still_required";

export async function scrapeBookingReviews(companyId: string): Promise<ScrapeResult> {
  const session = await createBookingSession(companyId);
  try {
    const authStatus = await ensureBookingAuthenticated(session);
    if (authStatus !== "ok") {
      const message =
        authStatus === "invalid_credentials"
          ? "BOOKING_AUTH_INVALID_CREDENTIALS"
          : authStatus === "security_block"
          ? "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
          : authStatus === "2fa_required"
          ? "BOOKING_AUTH_2FA_REQUIRED"
          : "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR";
      throw new Error(message);
    }
    const result = await scrapeReviewsWithSession(session);
    await saveCookies(session.context, companyId);
    return result;
  } finally {
    await session.browser.close();
  }
}

export async function createBookingSession(companyId: string): Promise<BookingSession> {
  console.log("[SCRAPER] Iniciando proceso para company:", companyId);

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

  return { companyId, browser, context, page };
}

function detectTwoFactor(bodyText: string): boolean {
  return (
    bodyText.includes("verificación") ||
    bodyText.includes("verificacion") ||
    bodyText.includes("verification") ||
    bodyText.includes("código") ||
    bodyText.includes("codigo") ||
    bodyText.includes("sms") ||
    bodyText.includes("phone call") ||
    bodyText.includes("two-step") ||
    bodyText.includes("2-step")
  );
}

async function selectSmsIfAvailable(page: Page): Promise<void> {
  const smsSelectors = [
    page.getByRole("button", { name: /sms|mensaje de texto|text message/i }),
    page.getByRole("link", { name: /sms|mensaje de texto|text message/i }),
    page.locator('text=/sms|mensaje de texto|text message/i'),
  ];

  for (const locator of smsSelectors) {
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const first = locator.first();
    const visible = await first.isVisible().catch(() => false);
    if (visible) {
      await first.click().catch(() => undefined);
      break;
    }
  }
}

async function looksLikeLogin(page: Page): Promise<boolean> {
  const usernameSelector = 'input[name="username"], input[type="email"]';
  const passwordSelector = 'input[type="password"]';
  const usernameInput = await page.$(usernameSelector);
  const passwordInput = await page.$(passwordSelector);
  return Boolean(usernameInput && passwordInput);
}

async function looksLikeTwoFactor(page: Page): Promise<boolean> {
  const otpSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="code"]',
    'input[name*="otp"]',
    'input[name*="verification"]',
  ];
  for (const selector of otpSelectors) {
    if (await page.$(selector)) return true;
  }
  const bodyText = ((await page.textContent("body")) || "").toLowerCase();
  return detectTwoFactor(bodyText);
}

export async function ensureBookingAuthenticated(session: BookingSession): Promise<AuthStatus> {
  const username = getEnvOrThrow("BOOKING_EXTRANET_USERNAME");
  const password = getEnvOrThrow("BOOKING_EXTRANET_PASSWORD");
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const loginUrl = getEnvOrThrow("BOOKING_LOGIN_URL");
  const hasEnvCookies = Boolean(process.env.BOOKING_COOKIES_JSON);

  const { page, context, companyId } = session;

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await humanDelay(page);
  await randomScroll(page);

  console.log(`[SCRAPER] Current URL after base load: ${page.url()}`);

  if (!page.url().startsWith(loginUrl) && !(await looksLikeLogin(page))) {
    return "ok";
  }

  const bodyTextRaw = (await page.textContent("body")) || "";
  const bodyText = bodyTextRaw.toLowerCase();

  if (hasEnvCookies) {
    if (detectTwoFactor(bodyText)) {
      await selectSmsIfAvailable(page);
      return "2fa_required";
    }
    console.log("[SCRAPER] Cookies loaded but Booking still redirected to login");
  }

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
    return "unknown";
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

  if (await looksLikeTwoFactor(page)) {
    await selectSmsIfAvailable(page);
    return "2fa_required";
  }

  if (page.url().startsWith(loginUrl) || (await looksLikeLogin(page))) {
    const updatedBodyRaw = (await page.textContent("body")) || "";
    const updatedBody = updatedBodyRaw.toLowerCase();

    if (
      updatedBody.includes("incorrect") ||
      updatedBody.includes("wrong password") ||
      updatedBody.includes("contraseña incorrecta") ||
      updatedBody.includes("usuario o contraseña")
    ) {
      return "invalid_credentials";
    }

    if (
      updatedBody.includes("unusual activity") ||
      updatedBody.includes("captcha") ||
      updatedBody.includes("blocked")
    ) {
      return "security_block";
    }

    return "unknown";
  }

  await saveCookies(context, companyId);
  return "ok";
}

export async function submitTwoFactorCode(
  session: BookingSession,
  code: string
): Promise<TwoFactorStatus> {
  const { page } = session;
  if (!code.trim()) return "invalid_code";

  const codeSelectors = [
    'input[autocomplete="one-time-code"]',
    'input[name*="code"]',
    'input[name*="otp"]',
    'input[name*="verification"]',
  ];

  let codeInput: null | any = null;
  for (const selector of codeSelectors) {
    const input = await page.$(selector);
    if (input) {
      codeInput = input;
      break;
    }
  }

  if (!codeInput) {
    return "still_required";
  }

  await codeInput.fill("");
  await codeInput.type(code, { delay: 80 });

  const submitSelector = 'button[type="submit"], button:has-text("Confirmar"), button:has-text("Verify"), button:has-text("Continuar")';
  const submitButton = await page.$(submitSelector);
  if (submitButton) {
    await submitButton.click();
  } else {
    await codeInput.press("Enter");
  }

  await humanDelay(page, 4000, 7000);

  if (await looksLikeTwoFactor(page)) {
    const bodyText = ((await page.textContent("body")) || "").toLowerCase();
    if (
      bodyText.includes("incorrect") ||
      bodyText.includes("código incorrecto") ||
      bodyText.includes("codigo incorrecto") ||
      bodyText.includes("invalid")
    ) {
      return "invalid_code";
    }
    return "still_required";
  }

  return "ok";
}

export async function scrapeReviewsWithSession(
  session: BookingSession
): Promise<ScrapeResult> {
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const { page } = session;

  const reviewsUrl = process.env.BOOKING_REVIEWS_URL;
  if (reviewsUrl) {
    await page.goto(reviewsUrl, { waitUntil: "networkidle" });
  } else {
    const candidatePaths = [
      "/hotel/hoteladmin/extranet_ng/manage/reviews.html",
      "/hotel/hoteladmin/extranet_ng/manage/review.html",
      "/hotel/hoteladmin/extranet_ng/manage/guest_reviews.html",
      "/reviews",
    ];

    let navigated = false;
    for (const path of candidatePaths) {
      try {
        await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
        navigated = true;
        break;
      } catch {
        // try next path
      }
    }

    if (!navigated) {
      const reviewsLink = page.getByRole("link", { name: /comentarios|reviews|opiniones/i });
      if ((await reviewsLink.count().catch(() => 0)) > 0) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle" }),
          reviewsLink.first().click(),
        ]);
      } else {
        throw new Error(
          "No se pudo navegar a la pagina de comentarios. Configura BOOKING_REVIEWS_URL en Railway."
        );
      }
    }
  }
  await humanDelay(page);
  await randomScroll(page);

  const exportCandidates = [
    page.getByRole("button", { name: /exportar|export/i }),
    page.getByRole("button", { name: /descargar comentarios de los clientes/i }),
    page.getByRole("link", { name: /exportar|export/i }),
    page.getByRole("link", { name: /descargar comentarios de los clientes/i }),
    page.locator('[data-testid*="export"]'),
    page.locator('button:has-text("Exportar")'),
    page.locator('button:has-text("Export")'),
    page.locator('button:has-text("Descargar comentarios de los clientes")'),
    page.locator('a:has-text("Exportar")'),
    page.locator('a:has-text("Export")'),
    page.locator('a:has-text("Descargar comentarios de los clientes")'),
    page.locator('text=/exportar|export/i'),
    page.locator('text=/descargar comentarios de los clientes/i'),
  ];

  let exportButton = null as null | ReturnType<typeof page.locator>;
  for (const locator of exportCandidates) {
    const first = locator.first();
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const visible = await first.isVisible().catch(() => false);
    if (visible) {
      exportButton = first;
      break;
    }
  }

  if (!exportButton) {
    throw new Error("Botón de exportación de reseñas no encontrado en Booking");
  }

  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    exportButton.scrollIntoViewIfNeeded().then(() => exportButton!.click()),
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
}

export async function persistCookies(session: BookingSession): Promise<void> {
  await saveCookies(session.context, session.companyId);
}
