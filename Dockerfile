FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY booking-scraper-service/package.json booking-scraper-service/package-lock.json* ./
RUN npm install --include=dev

COPY booking-scraper-service/tsconfig.json ./
COPY booking-scraper-service/src ./src

RUN npx tsc -p .

ENV NODE_ENV=production

CMD ["node", "dist/index.js"]
