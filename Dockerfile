FROM node:24-bookworm-slim AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json

# Runtime deps + drizzle-kit for one-shot migrate containers on deploy
RUN npm ci --omit=dev \
  && npm install drizzle-kit@0.31.10 --no-save

FROM oven/bun:1.3.4-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

# drizzle-kit CLI is a Node script; provide node next to bun
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node

COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
COPY db ./db
COPY drizzle.config.ts ./drizzle.config.ts
COPY scripts/docker-migrate.sh ./scripts/docker-migrate.sh

RUN chmod +x ./scripts/docker-migrate.sh

EXPOSE 3001

CMD ["bun", "apps/api/src/server.ts"]
