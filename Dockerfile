FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY prisma/schema.prisma prisma/schema.prisma
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-v11,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-meta-v11,target=/root/.cache/pnpm,sharing=locked \
    --mount=type=cache,id=modus-kontur-prisma-v6,target=/root/.cache/prisma,sharing=locked \
    PRISMA_SKIP_POSTINSTALL_GENERATE=1 pnpm install --frozen-lockfile --prefer-offline
COPY . .
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked pnpm build

FROM base AS server
RUN mkdir -p /app/.storage && chown node:node /app/.storage
USER node
CMD ["node", "dist/apps/api/src/main.js"]

FROM nginx:1.28-alpine AS web
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=base /app/apps/web/dist /usr/share/nginx/html
