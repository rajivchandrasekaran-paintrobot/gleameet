FROM node:20-alpine AS builder

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Copy workspace package.json files
COPY packages/shared/package.json packages/shared/
COPY packages/law-registry/package.json packages/law-registry/
COPY packages/backend/package.json packages/backend/

# Install all dependencies
RUN npm ci --ignore-scripts

# Copy source code
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/law-registry/ packages/law-registry/
COPY packages/backend/ packages/backend/

# Build all packages
RUN npm run build:shared && npm run build:law-registry && npm run build:backend

# --- Production image ---
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/law-registry/package.json packages/law-registry/
COPY packages/backend/package.json packages/backend/

# Install production dependencies only
RUN npm ci --omit=dev --ignore-scripts

# Copy built artifacts
COPY --from=builder /app/packages/shared/dist packages/shared/dist
COPY --from=builder /app/packages/law-registry/dist packages/law-registry/dist
COPY --from=builder /app/packages/law-registry/laws packages/law-registry/laws
COPY --from=builder /app/packages/backend/dist packages/backend/dist

# Copy schema for migrations
COPY packages/backend/src/db/schema.sql packages/backend/src/db/schema.sql

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

CMD ["node", "packages/backend/dist/index.js"]
