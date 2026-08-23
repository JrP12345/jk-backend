# syntax=docker/dockerfile:1

# ─── Stage 1: Install production dependencies ─────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
# ci = reproducible install from lockfile, omit dev deps for production image
RUN npm ci --omit=dev

# ─── Stage 2: Production runner ───────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application source (TypeScript runs natively via --experimental-strip-types)
COPY . .

EXPOSE 5000

# Healthcheck — Docker will mark container unhealthy if this fails
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:5000/api/health/readiness || exit 1

CMD ["node", "--experimental-strip-types", "index.ts"]
