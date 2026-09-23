# syntax=docker/dockerfile:1

# ─── Stage 1: Build & Bundle with esbuild ────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

# Install build dependencies
COPY package.json package-lock.json ./
RUN npm ci

# Copy source code and build bundle
COPY . .
RUN npx esbuild index.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/index.js --target=node20

# Prune devDependencies to keep final image minimal
RUN npm prune --omit=dev

# ─── Stage 2: Hardened Production Runner ──────────────────────────────────────
FROM node:20-alpine AS runner
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
  CMD wget -qO- http://localhost:5000/api/health/live || exit 1

CMD ["node", "dist/index.js"]
