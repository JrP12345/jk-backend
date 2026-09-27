# syntax=docker/dockerfile:1

# ─── Stage 1: Build & Bundle with esbuild ────────────────────────────────────
FROM node:24-alpine AS builder
WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json ./
RUN npm ci --include=dev

# Copy source code and build bundle
COPY . .
RUN npm run build

# Prune devDependencies to keep final image minimal
RUN npm prune --omit=dev

# ─── Stage 2: Hardened Production Runner ──────────────────────────────────────
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5000

# Create app directory permissions for non-root 'node' user
RUN mkdir -p /app/dist && chown -R node:node /app

# Copy production node_modules and built artifact from builder
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/package.json ./package.json

# Run as non-privileged user (Security requirement PRD-001)
USER node

EXPOSE 5000

# Healthcheck — periodically polls liveness probe
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 5000) + '/api/health/liveness', {headers: {Connection: 'close'}, signal: AbortSignal.timeout(4000)}).then(async r => {await r.arrayBuffer(); if (!r.ok) process.exitCode = 1;}).catch(() => {process.exitCode = 1;})"

CMD ["node", "dist/index.js"]
