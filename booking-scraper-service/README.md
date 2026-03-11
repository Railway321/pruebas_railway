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

## Scripts

- `npm install`
- `npm run dev` – arranca el servidor con `tsx`
- `npm run build` – compila a `dist/`
- `npm start` – ejecuta la versión compilada

## Docker

El `Dockerfile` usa `mcr.microsoft.com/playwright:v1.58.2-jammy` como base, instala dependencias y arranca el servidor. Solo tienes que apuntar Railway al subdirectorio `booking-scraper-service/` del repositorio y definir las variables de entorno anteriores.
