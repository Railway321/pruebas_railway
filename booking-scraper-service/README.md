# Booking Scraper Service

Microservicio Express + Playwright que inicia sesión en la extranet de Booking, exporta el CSV de reseñas y devuelve un JSON con las reseñas parseadas. Está pensado para desplegarse en Railway y ser consumido por la app principal de Valoraciones.

## Requisitos

- Node.js 20+
- Dependencias del sistema para Playwright (ya vienen incluidas si usas la imagen oficial en Docker)

## Variables de entorno

| Variable | Descripción |
| --- | --- |
| `BOOKING_EXTRANET_URL` | URL base de la extranet (por ejemplo `https://admin.booking.com`) |
| `BOOKING_LOGIN_URL` | URL de login (por ejemplo `https://account.booking.com/sign-in`) |
| `BOOKING_EXTRANET_USERNAME` | Usuario de la extranet |
| `BOOKING_EXTRANET_PASSWORD` | Contraseña de la extranet |
| `SCRAPER_API_KEY` | Token Bearer que debe incluir la app consumidora |
| `PORT` | Puerto HTTP (Railway lo define automáticamente) |
| `BOOKING_COOKIES_DIR` | (Opcional) Ruta donde guardar cookies; por defecto `./cookies` |
| `BOOKING_ENABLE_AUTOMATED_LOGIN` | (Opcional) Habilita el login automático como fallback. Por defecto `true`. Si es `false`, el scraper solo usará sesiones persistidas. |

## Endpoints de Sesión (Gestión manual de cookies)

### POST /session/:companyId

Guarda una sesión manual (cookies o storageState) subida desde la app principal.

**Body:**
```json
{
  "cookies": [...]  // o
  "storageState": { "cookies": [...], "origins": [...] }
}
```

**Respuesta:** `{ "success": true }`

### POST /session/:companyId/validate

Comprobar si la sesión persistida realmente sigue autenticada en Booking.

**Respuesta:**
```json
{
  "success": true,
  "authState": "ok" | "login_required" | "two_factor_required" | "security_block" | "unknown",
  "url": "...",
  "title": "..."
}
```

### GET /session/:companyId/status

Saber si existe una sesión guardada sin abrir navegador.

**Respuesta:**
```json
{
  "success": true,
  "exists": true,
  "hasCookies": true,
  "hasStorageState": true,
  "metadata": { ... }
}
```

### DELETE /session/:companyId

Borrar sesión persistida corrupta o caducada.

**Respuesta:** `{ "success": true }`

## Endpoints de Scraping

### POST /scrape/:companyId

Inicia el proceso de scrapeo de reseñas.

**Flujo:**
1. Crear sesión Playwright
2. Comprobar si ya existe sesión válida con `checkExistingBookingSession`
3. Si `ok`: seguir a scrapeo directo
4. Si `login_required` o `two_factor_required` y `BOOKING_ENABLE_AUTOMATED_LOGIN=true`: intentar login automático
5. Si `security_block`: devolver error de reautenticación manual
6. Al final, persistir la sesión actualizada (storageState si es posible)

### POST /scrape/:companyId/send-2fa

Envía código 2FA (para flujo de 2FA manual).

### POST /scrape/:companyId/verify-2fa

Verifica código 2FA.

### POST /scrape/:companyId/select-2fa-method

Selecciona método 2FA (SMS/Call).

## Errores

| Código HTTP | Error | Descripción |
| --- | --- | --- |
| 401 | `BOOKING_AUTH_INVALID_CREDENTIALS` | Credenciales inválidas |
| 401 | `BOOKING_SESSION_EXPIRED` | Sesión persistida expirada |
| 401 | `BOOKING_AUTH_2FA_REQUIRED` | Requiere 2FA |
| 409 | `BOOKING_SESSION_MISSING` | No hay sesión válida y login automático desactivado |
| 409 | `BOOKING_MANUAL_REAUTH_REQUIRED` | Se requiere reautenticación manual |
| 503 | `BOOKING_AUTH_SECURITY_BLOCK_OR_CAPTCHA` | Booking ha bloqueado el acceso (captcha/security check) |
| 502 | `BOOKING_AUTH_UNKNOWN_LOGIN_ERROR` | Error desconocido en login |

## Diferencia entre sesión persistida y login automático

- **Sesión persistida**: Cookies o storageState subida manualmente desde la app principal. Es la forma recomendada de operar para evitar bloqueos de Booking.
- **Login automático**: El scraper intenta hacer login con las credenciales configuradas. Es un fallback que puede triggers captchas.

Con `BOOKING_ENABLE_AUTOMATED_LOGIN=false`, el scraper solo usará sesiones persistidas y nunca intentará login automático.

## Persistencia de sesión

El scraper guarda:
- `cookies/booking-cookies-{companyId}.json` - Cookies simples (compatibilidad)
- `cookies/booking-storageState-{companyId}.json` - StorageState completo (preferido)
- `cookies/booking-session-meta-{companyId}.json` - Metadatos (fechas de última validación, último scrapeo, etc.)

## Scripts

- `npm install`
- `npm run dev` – arranca el servidor con `tsx`
- `npm run build` – compila a `dist/`
- `npm start` – ejecuta la versión compilada

## Docker

El `Dockerfile` usa `mcr.microsoft.com/playwright:v1.58.2-jammy` como base, instala dependencias y arranca el servidor. Solo tienes que apuntar Railway al subdirectorio `booking-scraper-service/` del repositorio y definir las variables de entorno anteriores.
