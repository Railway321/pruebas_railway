import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright";
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

export type SessionFormat = "cookies" | "storageState";
export type AuthCheckResult = "ok" | "login_required" | "two_factor_required" | "security_block" | "unknown";

export interface SessionMetadata {
  updatedAt: string;
  lastLoadedAt?: string;
  lastValidationAt?: string;
  lastValidationResult?: AuthCheckResult | string;
  lastScrapeAt?: string;
  lastScrapeResult?: string;
  format?: SessionFormat;
}

const BOOKING_ENABLE_AUTOMATED_LOGIN = String(process.env.BOOKING_ENABLE_AUTOMATED_LOGIN || "true").toLowerCase() !== "false";

async function ensureCookieDir() {
  await fs.mkdir(COOKIE_DIR, { recursive: true });
}

function getCookiesPath(companyId: string): string {
  return path.join(COOKIE_DIR, `booking-cookies-${companyId}.json`);
}

function getStorageStatePath(companyId: string): string {
  return path.join(COOKIE_DIR, `booking-storage-state-${companyId}.json`);
}

function getMetaPath(companyId: string): string {
  return path.join(COOKIE_DIR, `booking-session-meta-${companyId}.json`);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true).catch(() => false);
}

async function loadMetadata(companyId: string): Promise<SessionMetadata | null> {
  try {
    const raw = await fs.readFile(getMetaPath(companyId), "utf8");
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return null;
  }
}

async function saveMetadata(companyId: string, meta: Partial<SessionMetadata>): Promise<void> {
  try {
    await ensureCookieDir();
    const existing = (await loadMetadata(companyId)) || { updatedAt: new Date().toISOString() };
    const merged: SessionMetadata = {
      ...existing,
      ...meta,
      updatedAt: new Date().toISOString(),
    };
    await fs.writeFile(getMetaPath(companyId), JSON.stringify(merged, null, 2), "utf8");
  } catch (error) {
    console.warn("[SCRAPER] No se pudieron guardar metadatos de sesión:", error);
  }
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


export async function loadPersistedSession(
  context: BrowserContext,
  companyId: string
): Promise<{ format: SessionFormat; loaded: boolean }> {
  try {
    await ensureCookieDir();

    const VALID_COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'];
    
    const normalizeCookies = (cookies: any[]): any[] => {
      const validSameSite = ["Strict", "Lax", "None"];
      return cookies.map(cookie => {
        const filtered: any = {};
        VALID_COOKIE_FIELDS.forEach(field => {
          if (cookie[field] !== undefined) filtered[field] = cookie[field];
        });
        const sameSite = String(filtered.sameSite || "").toLowerCase();
        filtered.sameSite = validSameSite.includes(sameSite) 
          ? sameSite.charAt(0).toUpperCase() + sameSite.slice(1) 
          : "Lax";
        return filtered;
      });
    };

    const storageStatePath = getStorageStatePath(companyId);
    if (await fileExists(storageStatePath)) {
      console.log("[DEBUG] Loading storageState from:", storageStatePath);
      const raw = await fs.readFile(storageStatePath, "utf8");
      const storageState = JSON.parse(raw);
      if (Array.isArray(storageState?.cookies) && storageState.cookies.length > 0) {
        console.log("[DEBUG] storageState has", storageState.cookies.length, "cookies");
        const normalizedCookies = normalizeCookies(storageState.cookies);
        await context.addCookies(normalizedCookies);
        await saveMetadata(companyId, {
          format: "storageState",
          lastLoadedAt: new Date().toISOString(),
        });
        console.log(`[SCRAPER] Loaded storageState with ${storageState.cookies.length} cookies`);
        return { format: "storageState", loaded: true };
      }
    }

    const cookiesPath = getCookiesPath(companyId);
    if (await fileExists(cookiesPath)) {
      console.log("[DEBUG] Loading cookies from:", cookiesPath);
      const raw = await fs.readFile(cookiesPath, "utf8");
      const cookies = JSON.parse(raw);
      if (Array.isArray(cookies) && cookies.length > 0) {
        console.log("[DEBUG] Cookies file has", cookies.length, "cookies");
        const normalizedCookies = normalizeCookies(cookies);
        await context.addCookies(normalizedCookies);
        await saveMetadata(companyId, {
          format: "cookies",
          lastLoadedAt: new Date().toISOString(),
        });
        console.log(`[SCRAPER] Loaded ${cookies.length} cookies from persisted file`);
        return { format: "cookies", loaded: true };
      }
    }

    await loadCookies(context, companyId);
    return { format: "cookies", loaded: false };
  } catch (error) {
    console.warn("[SCRAPER] No se pudo cargar la sesión persistida:", error);
    return { format: "cookies", loaded: false };
  }
}

export async function savePersistedSession(
  context: BrowserContext,
  companyId: string,
  format: SessionFormat = "storageState"
): Promise<void> {
  try {
    await ensureCookieDir();

    if (format === "storageState") {
      const storageState = await context.storageState();
      await fs.writeFile(getStorageStatePath(companyId), JSON.stringify(storageState, null, 2), "utf8");
      console.log(`[SCRAPER] Saved storageState with ${storageState.cookies.length} cookies`);
    }

    await saveCookies(context, companyId);
    await saveMetadata(companyId, { format });
  } catch (error) {
    console.warn("[SCRAPER] No se pudo guardar la sesión persistida:", error);
  }
}

export async function storePersistedSession(
  companyId: string,
  payload: { cookies?: any[]; storageState?: { cookies?: any[]; origins?: any[] } }
): Promise<void> {
  await ensureCookieDir();

  if (payload.storageState) {
    await fs.writeFile(
      getStorageStatePath(companyId),
      JSON.stringify(payload.storageState, null, 2),
      "utf8"
    );
    const cookies = Array.isArray(payload.storageState.cookies) ? payload.storageState.cookies : [];
    await fs.writeFile(getCookiesPath(companyId), JSON.stringify(cookies, null, 2), "utf8");
    await saveMetadata(companyId, { format: "storageState" });
    return;
  }

  if (Array.isArray(payload.cookies)) {
    await fs.writeFile(getCookiesPath(companyId), JSON.stringify(payload.cookies, null, 2), "utf8");
    await saveMetadata(companyId, { format: "cookies" });
    return;
  }

  throw new Error("SESSION_PAYLOAD_INVALID");
}

export async function deletePersistedSession(companyId: string): Promise<void> {
  await ensureCookieDir();
  await Promise.all([
    fs.unlink(getCookiesPath(companyId)).catch(() => undefined),
    fs.unlink(getStorageStatePath(companyId)).catch(() => undefined),
    fs.unlink(getMetaPath(companyId)).catch(() => undefined),
  ]);
}

export async function getSessionStatus(companyId: string): Promise<{
  exists: boolean;
  hasCookies: boolean;
  hasStorageState: boolean;
  metadata: SessionMetadata | null;
}> {
  const [hasCookies, hasStorageState, metadata] = await Promise.all([
    fileExists(getCookiesPath(companyId)),
    fileExists(getStorageStatePath(companyId)),
    loadMetadata(companyId),
  ]);

  return {
    exists: hasCookies || hasStorageState,
    hasCookies,
    hasStorageState,
    metadata,
  };
}

export async function saveScreenshot(page: Page, companyId: string, prefix: string): Promise<string | null> {
  try {
    await ensureCookieDir();
    const screenshotPath = path.join(COOKIE_DIR, `${prefix}-${companyId}-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    return screenshotPath;
  } catch (error) {
    console.warn("[SCRAPER] No se pudo guardar screenshot:", error);
    return null;
  }
}

function randomDelay(minMs = 8000, maxMs = 15000): number {
  const diff = maxMs - minMs;
  return minMs + Math.floor(Math.random() * diff);
}

function getUserAgent(): string {
  return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
}

function buildBookingUrl(baseUrl: string, path: string): string {
  const parsed = new URL(baseUrl);
  parsed.pathname = path;
  parsed.searchParams.delete("ses");
  parsed.searchParams.delete("t");
  return parsed.toString();
}

function getBookingHomeUrl(baseUrl: string): string {
  return buildBookingUrl(baseUrl, "/hotel/hoteladmin/extranet_ng/manage/home.html");
}

function isBookingLoginUrl(url: string, loginUrl: string): boolean {
  return url.startsWith(loginUrl) || url.includes("account.booking.com/sign-in");
}

function isContextualHotelLogin(url: string): boolean {
  return url.includes("op_token=") && url.includes("hotel_id=");
}

function isBookingSsoUrl(url: string): boolean {
  return url.includes("bookingholdings.okta.com/") || url.includes("corpsso.booking.com/");
}

const LOGIN_USERNAME_SELECTOR = [
  'input[name="username"]',
  'input[name="identifier"]',
  'input[name="loginname"]',
  'input[id="username"]',
  'input[id="loginname"]',
  'input[id*="username"]',
  'input[id*="loginname"]',
  'input[id*="userid"]',
  'input[id*="user_id"]',
  'input[placeholder*="email" i]',
  'input[placeholder*="correo" i]',
  'input[placeholder*="usuario" i]',
  'input[placeholder*="user id" i]',
  'input[placeholder*="id de usuario" i]',
  'input[type="email"]',
  'input[type="text"]',
].join(", ");

const LOGIN_PASSWORD_SELECTOR = [
  'input[type="password"]:not([id="hidden-password"])',
  'input[name*="password"]:not([id="hidden-password"])',
  'input[id*="password"]:not([id="hidden-password"])',
].join(", ");

const LOGIN_PLACEHOLDER_PASSWORD_SELECTOR = 'input[type="password"]#hidden-password';

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

async function saveDebugScreenshot(page: Page, prefix: string): Promise<string | null> {
  try {
    const screenshotPath = `/tmp/${prefix}-${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await fs.writeFile(`/tmp/${prefix}-last.txt`, screenshotPath, "utf8").catch(() => undefined);
    console.log(`[SCRAPER] Saved debug screenshot (${prefix}): ${screenshotPath}`);
    return screenshotPath;
  } catch (error) {
    console.log(`[SCRAPER] Failed to save debug screenshot (${prefix})`, error);
    return null;
  }
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

export type TwoFactorType = "phone" | "email";

export interface TwoFactorAuthResult {
  status: "2fa_required";
  phoneOptions: PhoneOption[];
  twoFactorType: TwoFactorType;
}

export type AuthStatus =
  | "ok"
  | TwoFactorAuthResult
  | "invalid_credentials"
  | "security_block"
  | "unknown";

type BookingAuthState =
  | "two_factor"
  | "two_factor_email"
  | "security_check"
  | "login_username"
  | "login_password"
  | "login_full"
  | "unknown";

export type TwoFactorStatus = "ok" | "invalid_code" | "still_required";

export async function scrapeBookingReviews(companyId: string): Promise<ScrapeResult> {
  const session = await createBookingSession(companyId);
  try {
    const existingSession = await checkExistingBookingSession(session);
    console.log(`[SCRAPER] Existing session check: ${existingSession.result}`);

    if (existingSession.result === "security_block") {
      console.log("[DEBUG] security_block detected in scrapeBookingReviews, taking screenshot...");
      try {
        await saveScreenshot(session.page, companyId, "security-block");
        console.log("[DEBUG] Screenshot saved in scrapeBookingReviews!");
      } catch (e: any) {
        console.log("[DEBUG] Screenshot failed in scrapeBookingReviews:", e?.message);
      }
      throw new Error("BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA");
    }

    if (existingSession.result === "ok") {
      const result = await scrapeReviewsWithSession(session);
      await savePersistedSession(session.context, companyId, "storageState");
      await saveMetadata(companyId, {
        lastScrapeAt: new Date().toISOString(),
        lastScrapeResult: "success",
      });
      return result;
    }

    if (!BOOKING_ENABLE_AUTOMATED_LOGIN) {
      throw new Error(
        existingSession.result === "login_required"
          ? "BOOKING_SESSION_EXPIRED"
          : "BOOKING_MANUAL_REAUTH_REQUIRED"
      );
    }

    const authStatus = await ensureBookingAuthenticated(session);
    if (authStatus !== "ok") {
      const message =
        authStatus === "invalid_credentials"
          ? "BOOKING_AUTH_INVALID_CREDENTIALS"
          : authStatus === "security_block"
          ? "BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA"
          : typeof authStatus === "object" && authStatus.status === "2fa_required"
          ? "BOOKING_AUTH_2FA_REQUIRED"
          : "BOOKING_AUTH_UNKNOWN_LOGIN_ERROR";
      throw new Error(message);
    }

    const result = await scrapeReviewsWithSession(session);
    await savePersistedSession(session.context, companyId, "storageState");
    await saveMetadata(companyId, {
      lastScrapeAt: new Date().toISOString(),
      lastScrapeResult: "success",
    });
    return result;
  } finally {
    await session.context.close().catch(() => undefined);
    await session.browser.close().catch(() => undefined);
  }
}

export async function createBrowser(): Promise<Browser> {
  return chromium.launch({
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
}

export async function createContextWithPersistedSession(
  browser: Browser,
  companyId: string,
  loadPersisted = true
): Promise<BrowserContext> {
  const context = await browser.newContext({
    userAgent: getUserAgent(),
    viewport: { width: 1920, height: 1080 },
    locale: "es-ES",
    timezoneId: "Europe/Madrid",
    permissions: ["geolocation"],
  });

  if (loadPersisted) {
    await loadPersistedSession(context, companyId);
  } else {
    await loadCookies(context, companyId);
  }

  return context;
}

export async function createBookingSession(companyId: string, loadPersisted = true): Promise<BookingSession> {
  console.log("[SCRAPER] Iniciando proceso para company:", companyId);

  const browser = await createBrowser();
  const context = await createContextWithPersistedSession(browser, companyId, loadPersisted);

  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return { companyId, browser, context, page };
}

function detectTwoFactor(bodyText: string): boolean {
  return (
    bodyText.includes("código de verificación") ||
    bodyText.includes("codigo de verificacion") ||
    bodyText.includes("verification code") ||
    bodyText.includes("two-step verification") ||
    bodyText.includes("2-step verification") ||
    bodyText.includes("selecciona un número de teléfono") ||
    bodyText.includes("selecciona un numero de telefono") ||
    bodyText.includes("send verification") ||
    bodyText.includes("enviar código") ||
    bodyText.includes("enviar codigo")
  );
}

function detectSecurityChallenge(text: string, title = "", url = ""): boolean {
  const haystack = `${text} ${title} ${url}`.toLowerCase();
  return (
    haystack.includes("captcha") ||
    haystack.includes("unusual activity") ||
    haystack.includes("blocked") ||
    haystack.includes("déjanos comprobar que eres una persona") ||
    haystack.includes("dejanos comprobar que eres una persona") ||
    haystack.includes("let us check you're human") ||
    haystack.includes("prove you're human") ||
    haystack.includes("verifica que eres una persona")
  );
}

function detectEmailOtp(bodyText: string, url: string): boolean {
  if (url.includes("/otp/email-code")) return true;
  return (
    bodyText.includes("verify your email") ||
    bodyText.includes("verifica tu correo") ||
    bodyText.includes("verificar tu correo") ||
    bodyText.includes("código enviado a tu email") ||
    bodyText.includes("codigo enviado a tu email") ||
    bodyText.includes("email verification")
  );
}

async function hasVisibleSelector(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  return locator.isVisible().catch(() => false);
}

async function logVisibleInputs(page: Page, context: string): Promise<void> {
  try {
    const inputs = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll("input"))
          .map((el) => ({
            name: el.getAttribute("name") || "",
            type: el.getAttribute("type") || "",
            id: el.getAttribute("id") || "",
            placeholder: el.getAttribute("placeholder") || "",
          }))
          .filter((el) => el.name || el.type || el.id || el.placeholder)
      )
      .catch(() => [] as Array<{ name: string; type: string; id: string; placeholder: string }>);

    console.log(`[SCRAPER] Visible inputs (${context}):`, inputs);
  } catch (error) {
    console.log(`[SCRAPER] Failed to log inputs (${context}):`, error);
  }
}

async function logInputValueLengths(page: Page, context: string): Promise<void> {
  try {
    const [usernameValue, passwordValue] = await Promise.all([
      page.locator(LOGIN_USERNAME_SELECTOR).first().inputValue().catch(() => ""),
      page
        .locator(LOGIN_PASSWORD_SELECTOR)
        .first()
        .inputValue()
        .catch(() => ""),
    ]);
    console.log(
      `[SCRAPER] Input lengths (${context}): username=${usernameValue.length} password=${passwordValue.length}`
    );
  } catch (error) {
    console.log(`[SCRAPER] Failed to read input lengths (${context})`);
  }
}

async function resolveLoginIdentifier(
  page: Page,
  username: string,
  email: string | undefined
): Promise<string> {
  const mode = (process.env.BOOKING_EXTRANET_LOGIN_MODE || "").toLowerCase();
  if (mode === "email" && email) return email;
  if (mode === "username") return username;

  const usernameSelector = LOGIN_USERNAME_SELECTOR;
  const hints = await page
    .evaluate((selector) => {
      const input = document.querySelector(selector) as HTMLInputElement | null;
      if (!input) return "";
      const labelText = input.labels ? Array.from(input.labels).map((l) => l.textContent || "").join(" ") : "";
      const ariaLabel = input.getAttribute("aria-label") || "";
      const placeholder = input.getAttribute("placeholder") || "";
      const name = input.getAttribute("name") || "";
      const id = input.getAttribute("id") || "";
      return [labelText, ariaLabel, placeholder, name, id].join(" ").toLowerCase();
    }, usernameSelector)
    .catch(() => "");

  const looksLikeEmail = /email|e-mail|correo/.test(hints);
  if (looksLikeEmail && email) {
    console.log("[SCRAPER] Using email identifier based on input hints");
    return email;
  }

  const looksLikeUsername = /loginname|username|user id|id de usuario|también llamado|tambien llamado|usuario/.test(hints);
  if (looksLikeUsername) {
    console.log("[SCRAPER] Using username identifier based on input hints");
    return username;
  }

  console.log("[SCRAPER] Using username identifier based on input hints");
  return username;
}

async function hasLoginFields(page: Page): Promise<boolean> {
  const [hasUsername, hasPassword, hasPlaceholderPassword] = await Promise.all([
    hasVisibleSelector(page, LOGIN_USERNAME_SELECTOR),
    hasVisibleSelector(page, LOGIN_PASSWORD_SELECTOR),
    hasVisibleSelector(page, LOGIN_PLACEHOLDER_PASSWORD_SELECTOR),
  ]);
  return Boolean(hasUsername || hasPassword || hasPlaceholderPassword);
}

export interface PhoneOption {
  id: string;
  label: string;
}

export async function extractPhoneOptions(page: Page): Promise<PhoneOption[]> {
  const isPhoneLike = (value: string) =>
    /(\+?\d[\d\s*]{3,}|\*{2,}\s*\d{2,})/.test(value);

  const addOption = (options: PhoneOption[], label: string, idPrefix: string) => {
    if (!label || label.length <= 3 || !isPhoneLike(label)) return;
    if (options.find((o) => o.label === label)) return;
    const id = `${idPrefix}_${Buffer.from(label).toString("base64").slice(0, 12)}`;
    options.push({ id, label });
  };

  const fromDom = await page
    .evaluate(() => {
      const results: string[] = [];
      const isPhoneLike = (value: string) =>
        /(\+?\d[\d\s*]{3,}|\*{2,}\s*\d{2,})/.test(value);

      const collectFromRoot = (root: Document | ShadowRoot) => {
        const selects = Array.from(root.querySelectorAll("select"));
        for (const select of selects) {
          const options = Array.from(select.options);
          for (const option of options) {
            const label = (option.textContent || "").trim();
            if (label && isPhoneLike(label)) {
              results.push(label);
            }
          }
        }

        const listOptions = Array.from(
          root.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li')
        );
        for (const el of listOptions) {
          const label = (el.textContent || "").trim();
          if (label && isPhoneLike(label)) {
            results.push(label);
          }
        }
      };

      const walk = (node: Element | Document | ShadowRoot) => {
        if (node instanceof Document || node instanceof ShadowRoot) {
          collectFromRoot(node);
        }
        const elements = node instanceof Element ? [node] : Array.from(node.children ?? []);
        for (const el of elements) {
          const shadow = (el as Element).shadowRoot;
          if (shadow) {
            walk(shadow);
          }
          const children = (el as Element).children;
          if (children && children.length) {
            for (const child of Array.from(children)) {
              walk(child);
            }
          }
        }
      };

      walk(document);
      return Array.from(new Set(results));
    })
    .catch(() => [] as string[]);

  if (fromDom.length > 0) {
    const domOptions: PhoneOption[] = [];
    for (const label of fromDom) {
      addOption(domOptions, label, "phone_dom");
    }
    if (domOptions.length > 0) {
      console.log(`[SCRAPER] Phone options found via DOM: ${domOptions.length}`);
      return domOptions;
    }
  }

  const extractFromFrame = async (frame: Frame): Promise<PhoneOption[]> => {
    const options: PhoneOption[] = [];
    const selectLocator = frame.locator("select");
    const comboboxLocator = frame.locator(
      '[role="combobox"], [aria-haspopup="listbox"], [aria-expanded]'
    );

    await frame
      .waitForFunction(
        () => {
          const selects = Array.from(document.querySelectorAll("select"));
          const selectHasPhone = selects.some((select) =>
            Array.from(select.options).some((opt) => /\*\d{2,}|\+?\d/.test(opt.textContent || ""))
          );
          const listboxHasPhone = Array.from(
            document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li')
          ).some((el) => /\*\d{2,}|\+?\d/.test(el.textContent || ""));
          return selectHasPhone || listboxHasPhone;
        },
        { timeout: 5000 }
      )
      .catch(() => undefined);
    const selectCount = await selectLocator.count().catch(() => 0);
    for (let i = 0; i < selectCount; i++) {
      const selectEl = selectLocator.nth(i);
      const optionLocator = selectEl.locator("option");
      const optionCount = await optionLocator.count().catch(() => 0);
      if (optionCount > 0) {
        const sample = await optionLocator
          .first()
          .textContent()
          .catch(() => null);
        console.log(
          `[SCRAPER] select options found (${optionCount}) in frame ${frame.url()} sample=${(sample ?? "").trim()}`
        );
      }
      for (let j = 0; j < optionCount; j++) {
        const optionEl = optionLocator.nth(j);
        const text = await optionEl.textContent().catch(() => null);
        const label = (text ?? "").trim();
        addOption(options, label, `phone_select_${i}_${j}`);
      }
    }

    const comboboxCount = await comboboxLocator.count().catch(() => 0);
    for (let i = 0; i < comboboxCount; i++) {
      const combobox = comboboxLocator.nth(i);
      const visible = await combobox.isVisible().catch(() => false);
      if (!visible) continue;
      await combobox.click().catch(() => undefined);
      await frame.page().waitForTimeout(300);
      const listboxOptions = frame.locator('[role="listbox"] [role="option"], [role="listbox"] li');
      const listCount = await listboxOptions.count().catch(() => 0);
      for (let j = 0; j < listCount; j++) {
        const el = listboxOptions.nth(j);
        const text = await el.textContent().catch(() => null);
        const label = (text ?? "").trim();
        const optVisible = await el.isVisible().catch(() => false);
        if (optVisible) {
          addOption(options, label, `phone_list_${i}_${j}`);
        }
      }
      await frame.page().keyboard.press("Escape").catch(() => undefined);
      if (options.length > 0) break;
    }

    if (options.length === 0) {
      const listboxOptions = frame.locator('[role="listbox"] [role="option"], [role="listbox"] li');
      const listCount = await listboxOptions.count().catch(() => 0);
      for (let i = 0; i < listCount; i++) {
        const el = listboxOptions.nth(i);
        const text = await el.textContent().catch(() => null);
        const label = (text ?? "").trim();
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          addOption(options, label, `phone_list_${i}`);
        }
      }
    }

    const phoneSelectors = [
      frame.locator('input[name*="phone"]'),
      frame.locator('input[type="tel"]'),
      frame.locator('input[autocomplete="tel"]'),
      frame.locator('label:has(input[type="radio"]):not(:has-text(/sms|call|llamada|texto/i))'),
      frame.locator('div:has(input[type="radio"])'),
      frame.locator('li:has(input[type="radio"])'),
      frame.locator('label:has(input[type="checkbox"]):not(:has-text(/sms|call|llamada|texto/i))'),
    ];

    for (const selector of phoneSelectors) {
      const count = await selector.count().catch(() => 0);
      if (count === 0) continue;

      for (let i = 0; i < count; i++) {
        const el = selector.nth(i);
        const text = await el.textContent().catch(() => null);
        const label = (text ?? "").trim();
        addOption(options, label, `phone_${i}`);
      }
    }

    if (options.length === 0) {
      const textLocator = frame.locator(
        'button, label, div, span, li, p, a, [role="option"], [role="button"], [role="radio"]'
      );
      const textCount = await textLocator.count().catch(() => 0);
      for (let i = 0; i < Math.min(textCount, 200); i++) {
        const el = textLocator.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;
        const text = await el.textContent().catch(() => null);
        const label = (text ?? "").trim();
        if (label && label.includes("*") && isPhoneLike(label)) {
          addOption(options, label, `phone_text_${i}`);
        }
        if (options.length >= 10) break;
      }
    }

    if (options.length === 0) {
      const selectCount = await selectLocator.count().catch(() => 0);
      const listboxCount = await frame.locator('[role="listbox"]').count().catch(() => 0);
      const comboboxCount = await comboboxLocator.count().catch(() => 0);
      console.log(
        `[SCRAPER] No phone options in frame ${frame.url()} | selects=${selectCount} listbox=${listboxCount} combobox=${comboboxCount}`
      );
    }

    return options;
  };

  const frames = page.frames();
  for (const frame of frames) {
    const options = await extractFromFrame(frame);
    if (options.length > 0) {
      if (frame !== page.mainFrame()) {
        console.log(`[SCRAPER] Phone options found in frame: ${frame.url()}`);
      }
      return options;
    }
  }

  const frameUrls = frames.map((f) => f.url()).filter(Boolean);
  console.log(
    `[SCRAPER] No phone options found. Frames: ${frameUrls.join(" | ") || "none"}`
  );
  return [];
}

export async function selectPhoneOption(
  page: Page,
  phoneLabel: string
): Promise<boolean> {
  const normalizedLabel = phoneLabel.toLowerCase().replace(/\s/g, "");

  const trySelectInFrame = async (frame: Frame): Promise<boolean> => {
    const selectLocator = frame.locator("select");
    const selectCount = await selectLocator.count().catch(() => 0);
    for (let i = 0; i < selectCount; i++) {
      const selectEl = selectLocator.nth(i);
      const optionLocator = selectEl.locator("option");
      const optionCount = await optionLocator.count().catch(() => 0);
      for (let j = 0; j < optionCount; j++) {
        const optionEl = optionLocator.nth(j);
        const text = await optionEl.textContent().catch(() => null);
        const label = (text ?? "").trim();
        if (!label) continue;
        if (label.toLowerCase().replace(/\s/g, "") === normalizedLabel) {
          const value = await optionEl.getAttribute("value");
          if (value) {
            await selectEl.selectOption(value).catch(() => undefined);
            return true;
          }
        }
      }
    }

    const comboboxLocator = frame.locator('[role="combobox"], [aria-haspopup="listbox"], [aria-expanded]');
    const comboboxCount = await comboboxLocator.count().catch(() => 0);
    for (let i = 0; i < comboboxCount; i++) {
      const combobox = comboboxLocator.nth(i);
      const visible = await combobox.isVisible().catch(() => false);
      if (!visible) continue;
      await combobox.click().catch(() => undefined);
      await frame.page().waitForTimeout(300);
      const optionLocator = frame.locator('[role="listbox"] [role="option"], [role="listbox"] li');
      const optionCount = await optionLocator.count().catch(() => 0);
      for (let j = 0; j < optionCount; j++) {
        const optionEl = optionLocator.nth(j);
        const text = await optionEl.textContent().catch(() => null);
        const label = (text ?? "").trim();
        if (label && label.toLowerCase().replace(/\s/g, "") === normalizedLabel) {
          await optionEl.click().catch(() => undefined);
          return true;
        }
      }
      await frame.page().keyboard.press("Escape").catch(() => undefined);
    }

    const phoneLocators = [
      frame.locator(`label:has-text("${phoneLabel}")`),
      frame.locator(`text=/${phoneLabel}/i`),
      frame.locator(`div:has-text("${phoneLabel}")`),
      frame.locator(`li:has-text("${phoneLabel}")`),
      frame
        .locator('label:has(input[type="radio"])')
        .filter({
          hasText: new RegExp(
            phoneLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
            "i"
          ),
        }),
    ];

    for (const locator of phoneLocators) {
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          await el.click().catch(() => undefined);
          await page.waitForTimeout(500);
          return true;
        }
      }
    }

    const allRadioLabels = frame.locator(
      'label:has(input[type="radio"]), li:has(input[type="radio"])'
    );
    const radioCount = await allRadioLabels.count().catch(() => 0);
    for (let i = 0; i < radioCount; i++) {
      const el = allRadioLabels.nth(i);
      const text = await el.textContent().catch(() => "");
      if (
        text &&
        text
          .toLowerCase()
          .replace(/\s/g, "")
          .includes(normalizedLabel.replace(/\*/g, "X"))
      ) {
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          await el.click().catch(() => undefined);
          await page.waitForTimeout(500);
          return true;
        }
      }
    }

    return false;
  };

  const frames = page.frames();
  for (const frame of frames) {
    const selected = await trySelectInFrame(frame);
    if (selected) return true;
  }

  return false;
}

export async function selectTwoFactorMethod(
  page: Page,
  method: "sms" | "call"
): Promise<void> {
  const selectors =
    method === "call"
      ? [
          page.getByRole("button", { name: /llamada|call|phone call/i }),
          page.getByRole("link", { name: /llamada|call|phone call/i }),
          page.locator('text=/llamada|call|phone call/i'),
        ]
      : [
          page.getByRole("button", { name: /sms|mensaje de texto|text message/i }),
          page.getByRole("link", { name: /sms|mensaje de texto|text message/i }),
          page.locator('text=/sms|mensaje de texto|text message/i'),
        ];

  for (const locator of selectors) {
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

export async function requestTwoFactorCode(
  page: Page,
  method: "sms" | "call"
): Promise<void> {
  await selectTwoFactorMethod(page, method);

  const sendSelectors = [
    page.getByRole("button", { name: /enviar|send|continuar|continue|confirmar|confirm/i }),
    page.getByRole("link", { name: /enviar|send|continuar|continue|confirmar|confirm/i }),
    page.locator('button:has-text("Enviar")'),
    page.locator('button:has-text("Send")'),
    page.locator('button:has-text("Continuar")'),
    page.locator('button:has-text("Continue")'),
    page.locator('button:has-text("Confirmar")'),
    page.locator('button:has-text("Confirm")'),
    page.locator('text=/enviar código|enviar codigo|send code|send verification/i'),
  ];

  for (const locator of sendSelectors) {
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const first = locator.first();
    const visible = await first.isVisible().catch(() => false);
    if (visible) {
      await first.click().catch(() => undefined);
      await page.waitForTimeout(1500);
      break;
    }
  }
}

async function looksLikeLogin(page: Page): Promise<boolean> {
  const [hasUsername, hasPassword, hasPlaceholderPassword] = await Promise.all([
    hasVisibleSelector(page, LOGIN_USERNAME_SELECTOR),
    hasVisibleSelector(page, LOGIN_PASSWORD_SELECTOR),
    hasVisibleSelector(page, LOGIN_PLACEHOLDER_PASSWORD_SELECTOR),
  ]);
  return Boolean(hasUsername || hasPassword || hasPlaceholderPassword);
}

async function looksLikeTwoFactor(page: Page): Promise<boolean> {
  if (await hasLoginFields(page)) {
    return false;
  }
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
  const title = await page.title().catch(() => "");
  if (detectSecurityChallenge(bodyText, title, page.url())) return false;
  return detectTwoFactor(bodyText);
}

export async function checkExistingBookingSession(
  session: BookingSession
): Promise<{
  result: AuthCheckResult;
  url: string;
  title: string;
}> {
  console.log("[DEBUG] checkExistingBookingSession: START");
  console.log("[DEBUG] page.isClosed():", session.page.isClosed());
  console.log("[DEBUG] browser.isConnected():", session.browser.isConnected());
  
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const { page, companyId } = session;

  console.log("[DEBUG] Navigating to:", getBookingHomeUrl(baseUrl));
  await page.goto(getBookingHomeUrl(baseUrl), { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  console.log("[DEBUG] After navigation, page.isClosed():", session.page.isClosed());

  const state = await describeAuthState(page);
  console.log("[DEBUG] describeAuthState result:", state.state, "| url:", state.url);

  let result: AuthCheckResult;
  switch (state.state) {
    case "login_full":
    case "login_username":
    case "login_password":
      result = "login_required";
      break;
    case "two_factor":
    case "two_factor_email":
      result = "two_factor_required";
      break;
    case "security_check":
      result = "security_block";
      break;
    default:
      result = isBookingLoginUrl(state.url, getEnvOrThrow("BOOKING_LOGIN_URL")) || (await looksLikeLogin(page))
        ? "login_required"
        : "ok";
      break;
  }

  await saveMetadata(companyId, {
    lastValidationAt: new Date().toISOString(),
    lastValidationResult: result,
  });

  return { result, url: state.url, title: state.title };
}

export async function describeAuthState(page: Page): Promise<{
  state: BookingAuthState;
  url: string;
  title: string;
}> {
  const [hasUsername, hasPassword, hasPlaceholderPassword] = await Promise.all([
    hasVisibleSelector(page, LOGIN_USERNAME_SELECTOR),
    hasVisibleSelector(page, LOGIN_PASSWORD_SELECTOR),
    hasVisibleSelector(page, LOGIN_PLACEHOLDER_PASSWORD_SELECTOR),
  ]);

  const bodyText = ((await page.textContent("body")) || "").toLowerCase();
  const title = await page.title();
  if (detectSecurityChallenge(bodyText, title, page.url())) {
    return { state: "security_check", url: page.url(), title };
  }

  if (await looksLikeTwoFactor(page)) {
    const state = detectEmailOtp(bodyText, page.url()) ? "two_factor_email" : "two_factor";
    return { state, url: page.url(), title };
  }

  if (hasUsername && hasPassword) {
    return { state: "login_full", url: page.url(), title };
  }

  if (hasUsername && !hasPassword) {
    return { state: "login_username", url: page.url(), title };
  }

  if (!hasUsername && (hasPassword || hasPlaceholderPassword)) {
    return { state: "login_password", url: page.url(), title };
  }

  return { state: "unknown", url: page.url(), title };
}

async function clickFirstVisible(locators: Array<ReturnType<Page["locator"]>>): Promise<boolean> {
  for (const locator of locators) {
    const count = await locator.count().catch(() => 0);
    if (count === 0) continue;
    const first = locator.first();
    const visible = await first.isVisible().catch(() => false);
    if (visible) {
      await first.click().catch(() => undefined);
      return true;
    }
  }
  return false;
}

async function submitLoginStep(
  page: Page,
  input: ReturnType<Page["locator"]>,
  submitLocators: Array<ReturnType<Page["locator"]>>,
  label: string,
  successStates: Array<BookingAuthState>
): Promise<{
  state: BookingAuthState;
  url: string;
  title: string;
}> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await input.focus().catch(() => undefined);
    const clicked = await clickFirstVisible(submitLocators);
    if (!clicked) {
      await input.press("Enter").catch(() => undefined);
      await page.keyboard.press("Enter").catch(() => undefined);
    }

    await humanDelay(page, 1200, 2200);
    const state = await describeAuthState(page);
    console.log(
      `[SCRAPER] ${label} submit attempt ${attempt + 1}/3 | state=${state.state} | title=${state.title} | url=${state.url}`
    );
    if (successStates.includes(state.state)) {
      return state;
    }

    await page
      .locator('form button[type="submit"], form input[type="submit"]')
      .first()
      .click()
      .catch(() => undefined);
    await humanDelay(page, 1200, 2200);
    const fallbackState = await describeAuthState(page);
    console.log(
      `[SCRAPER] ${label} fallback submit ${attempt + 1}/3 | state=${fallbackState.state} | title=${fallbackState.title} | url=${fallbackState.url}`
    );
    if (successStates.includes(fallbackState.state)) {
      return fallbackState;
    }
  }

  return describeAuthState(page);
}

async function waitForAuthProgress(page: Page, label: string): Promise<{
  state: BookingAuthState;
  url: string;
  title: string;
}> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = await describeAuthState(page);
    console.log(
      `[SCRAPER] ${label} attempt ${attempt + 1}/12 | state=${state.state} | title=${state.title} | url=${state.url}`
    );
    if (
      state.state === "login_username" ||
      state.state === "login_password" ||
      state.state === "login_full" ||
      state.state === "security_check" ||
      state.state === "two_factor" ||
      state.state === "two_factor_email"
    ) {
      return state;
    }
    await page.waitForTimeout(1000);
  }

  return describeAuthState(page);
}

export async function ensureBookingAuthenticated(session: BookingSession): Promise<AuthStatus> {
  const username = getEnvOrThrow("BOOKING_EXTRANET_USERNAME");
  const password = getEnvOrThrow("BOOKING_EXTRANET_PASSWORD");
  const loginEmail = process.env.BOOKING_EXTRANET_EMAIL;
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const loginUrl = getEnvOrThrow("BOOKING_LOGIN_URL");
  const hasEnvCookies = Boolean(process.env.BOOKING_COOKIES_JSON);

  const { page, context, companyId } = session;

  await page.goto(getBookingHomeUrl(baseUrl), { waitUntil: "domcontentloaded" });
  await humanDelay(page);
  await randomScroll(page);

  console.log(`[SCRAPER] Current URL after base load: ${page.url()}`);

  if (isBookingSsoUrl(page.url())) {
    const ssoState = await waitForAuthProgress(page, "Waiting SSO redirect");
    console.log(
      `[SCRAPER] SSO redirect resolved to ${ssoState.state} | ${ssoState.url}`
    );
  }

  if (!isBookingLoginUrl(page.url(), loginUrl) && !(await looksLikeLogin(page))) {
    return "ok";
  }

  const bodyTextRaw = (await page.textContent("body")) || "";
  const bodyText = bodyTextRaw.toLowerCase();

  if (hasEnvCookies) {
    const loginFields = await hasLoginFields(page);
    if (await looksLikeTwoFactor(page)) {
      const currentBody = ((await page.textContent("body")) || "").toLowerCase();
      const twoFactorType = detectEmailOtp(currentBody, page.url()) ? "email" : "phone";
      return { status: "2fa_required", phoneOptions: [], twoFactorType };
    }
    if (loginFields) {
      console.log("[SCRAPER] Cookies loaded but login fields are visible");
    } else {
      console.log("[SCRAPER] Cookies loaded but Booking still redirected to login");
    }
  }

  const contextualLoginUrl = page.url();
  const shouldUseCurrentLoginPage = isContextualHotelLogin(contextualLoginUrl) || (await looksLikeLogin(page));
  if (!shouldUseCurrentLoginPage) {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
    await humanDelay(page);
    await randomScroll(page);
  } else {
    console.log(`[SCRAPER] Preserving contextual login flow: ${contextualLoginUrl}`);
  }

  const usernameSelector = LOGIN_USERNAME_SELECTOR;
  const passwordSelector = LOGIN_PASSWORD_SELECTOR;
  const submitLocators = [
    page.getByRole("button", { name: /siguiente/i }),
    page.getByRole("button", { name: /next/i }),
    page.getByRole("button", { name: /continuar/i }),
    page.getByRole("button", { name: /continue/i }),
    page.getByRole("button", { name: /iniciar sesión/i }),
    page.getByRole("button", { name: /sign in/i }),
    page.locator('button[type="submit"]'),
    page.locator('input[type="submit"]'),
    page.locator('button[data-ga-label="login-button"]'),
  ];

  const initialState = await describeAuthState(page);
  console.log(
    `[SCRAPER] Auth state after login load: ${initialState.state} | ${initialState.title} | ${initialState.url}`
  );
  await logVisibleInputs(page, "after login load");

  const hasUsernameVisible = await hasVisibleSelector(page, usernameSelector);
  const hasPasswordVisible = await hasVisibleSelector(page, passwordSelector);

  if (hasUsernameVisible && !hasPasswordVisible) {
    const usernameInput = page.locator(usernameSelector).first();
    const loginIdentifier = await resolveLoginIdentifier(page, username, loginEmail);
    await usernameInput.fill("").catch(() => undefined);
    await usernameInput.type(loginIdentifier, { delay: Math.random() * 80 + 30 });
    await logInputValueLengths(page, "after username fill");
    await humanDelay(page);
    const progressState = await submitLoginStep(page, usernameInput, submitLocators, "After username", [
      "login_password",
      "login_full",
      "security_check",
      "two_factor",
      "two_factor_email",
      "unknown",
    ]);
    console.log(
      `[SCRAPER] Username submit resolved to ${progressState.state} | ${progressState.url}`
    );
    if (progressState.state === "security_check") {
      await saveDebugScreenshot(page, "booking-login-security-check");
      return "security_block";
    }
  }

  const passwordInputAfterVisible = await hasVisibleSelector(page, passwordSelector);
  const usernameInputAfterVisible = await hasVisibleSelector(page, usernameSelector);

  if (!passwordInputAfterVisible) {
    const state = await describeAuthState(page);
    console.log(
      `[SCRAPER] Auth state before password entry: ${state.state} | ${state.title} | ${state.url}`
    );
    await logVisibleInputs(page, "before password entry");
    if (state.state === "security_check") {
      await saveDebugScreenshot(page, "booking-login-security-check");
      return "security_block";
    }
    if (state.state === "two_factor") {
      const currentBody = ((await page.textContent("body")) || "").toLowerCase();
      const twoFactorType = detectEmailOtp(currentBody, page.url()) ? "email" : "phone";
      return { status: "2fa_required", phoneOptions: [], twoFactorType };
    }
    if (state.state === "two_factor_email") {
      return { status: "2fa_required", phoneOptions: [], twoFactorType: "email" };
    }
    return "unknown";
  }

  if (usernameInputAfterVisible) {
    const usernameInputAfter = page.locator(usernameSelector).first();
    const loginIdentifier = await resolveLoginIdentifier(page, username, loginEmail);
    const currentValue = await usernameInputAfter.inputValue().catch(() => "");
    if (!currentValue) {
      await usernameInputAfter.fill("").catch(() => undefined);
      await usernameInputAfter.type(loginIdentifier, { delay: Math.random() * 80 + 30 });
      await humanDelay(page);
    }
  }

  const passwordInputAfter = page.locator(passwordSelector).first();
  await passwordInputAfter.fill("").catch(() => undefined);
  await passwordInputAfter.type(password, { delay: Math.random() * 80 + 30 });
  await logInputValueLengths(page, "after password fill");
  await humanDelay(page);
  await submitLoginStep(page, passwordInputAfter, submitLocators, "After password", [
    "security_check",
    "two_factor",
    "two_factor_email",
    "unknown",
  ]);

  await humanDelay(page, 3500, 5500);
  await randomScroll(page);

  const postPasswordBody = ((await page.textContent("body")) || "").toLowerCase();
  if (detectSecurityChallenge(postPasswordBody, await page.title().catch(() => ""), page.url())) {
    await saveDebugScreenshot(page, "booking-login-security-check");
    return "security_block";
  }

  if (await looksLikeTwoFactor(page)) {
    const updatedBodyRaw = (await page.textContent("body")) || "";
    const updatedBody = updatedBodyRaw.toLowerCase();
    const twoFactorType = detectEmailOtp(updatedBody, page.url()) ? "email" : "phone";
    return { status: "2fa_required", phoneOptions: [], twoFactorType };
  }

  await page.goto(getBookingHomeUrl(baseUrl), { waitUntil: "domcontentloaded" }).catch(() => undefined);
  await humanDelay(page, 1500, 2500);

  const finalState = await describeAuthState(page);
  console.log(
    `[SCRAPER] Final auth state after password submit: ${finalState.state} | ${finalState.title} | ${finalState.url}`
  );

  if (isBookingLoginUrl(page.url(), loginUrl) || (await looksLikeLogin(page))) {
    const updatedBodyRaw = (await page.textContent("body")) || "";
    const updatedBody = updatedBodyRaw.toLowerCase();

    await logVisibleInputs(page, "after login submit");
    const invalidPath = `/tmp/booking-login-invalid-${Date.now()}.png`;
    await page.screenshot({ path: invalidPath, fullPage: true }).catch(() => undefined);
    await fs.writeFile("/tmp/booking-login-last.txt", invalidPath).catch(() => undefined);
    console.log(`[SCRAPER] Saved login screenshot: ${invalidPath}`);

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
  code: string,
  method: "sms" | "call" = "sms",
  phoneLabel?: string
): Promise<TwoFactorStatus> {
  const { page } = session;
  if (!code.trim()) return "invalid_code";

  if (phoneLabel) {
    await selectPhoneOption(page, phoneLabel);
  }

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

  const submitSelector = 'button[type="submit"], button:has-text("Confirmar"), button:has-text("Verify"), button:has-text("Continuar"), button:has-text("Enviar")';
  const submitButton = await page.$(submitSelector);
  if (submitButton) {
    await submitButton.click();
  } else {
    await codeInput.press("Enter");
  }

  await humanDelay(page, 4000, 7000);

  if (await looksLikeTwoFactor(page)) {
    const bodyText = ((await page.textContent("body")) || "").toLowerCase();
    await saveDebugScreenshot(page, "booking-post-otp-2fa");
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

  const stateAfterCode = await describeAuthState(page);
  console.log(
    `[SCRAPER] Auth state after 2FA code submit: ${stateAfterCode.state} | ${stateAfterCode.title} | ${stateAfterCode.url}`
  );
  await saveDebugScreenshot(page, "booking-post-otp-state");

  return "ok";
}

export async function scrapeReviewsWithSession(
  session: BookingSession
): Promise<ScrapeResult> {
  const baseUrl = getEnvOrThrow("BOOKING_EXTRANET_URL");
  const { page } = session;

  console.log(`[SCRAPER] Starting review scrape from: ${page.url()}`);

  const reviewsUrl = process.env.BOOKING_REVIEWS_URL;
  if (reviewsUrl) {
    await page.goto(reviewsUrl, { waitUntil: "networkidle" });
  } else {
    const candidateUrls = [
      buildBookingUrl(baseUrl, "/hotel/hoteladmin/extranet_ng/manage/reviews.html"),
      buildBookingUrl(baseUrl, "/hotel/hoteladmin/extranet_ng/manage/review.html"),
      buildBookingUrl(baseUrl, "/hotel/hoteladmin/extranet_ng/manage/guest_reviews.html"),
      buildBookingUrl(baseUrl, "/hotel/hoteladmin/extranet_ng/manage/home.html"),
      new URL("/reviews", baseUrl).toString(),
    ];

    let navigated = false;
    for (const candidateUrl of candidateUrls) {
      try {
        await page.goto(candidateUrl, { waitUntil: "networkidle" });
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

  console.log(`[SCRAPER] Review page after navigation: ${page.url()}`);
  const reviewAuthState = await describeAuthState(page);
  console.log(
    `[SCRAPER] Auth state before export lookup: ${reviewAuthState.state} | ${reviewAuthState.title} | ${reviewAuthState.url}`
  );

  if (
    reviewAuthState.state === "login_username" ||
    reviewAuthState.state === "login_password" ||
    reviewAuthState.state === "login_full" ||
    reviewAuthState.state === "two_factor" ||
    reviewAuthState.state === "two_factor_email"
  ) {
    throw new Error("BOOKING_AUTH_CONTEXT_NOT_READY_FOR_REVIEWS");
  }

  await saveDebugScreenshot(page, "booking-before-export");

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
    await saveDebugScreenshot(page, "booking-reviews-missing-export");
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
  await savePersistedSession(session.context, session.companyId, "storageState");
}
