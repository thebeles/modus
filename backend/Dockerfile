FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
COPY backend/prisma/schema.prisma backend/prisma/schema.prisma
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-v11,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-meta-v11,target=/root/.cache/pnpm,sharing=locked \
    --mount=type=cache,id=modus-kontur-prisma-v6,target=/root/.cache/prisma,sharing=locked \
    PRISMA_SKIP_POSTINSTALL_GENERATE=1 pnpm --filter @kontur/api install --frozen-lockfile --prefer-offline
COPY backend/ backend/
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked pnpm --filter @kontur/api build

RUN mkdir -p /app/.storage && chown node:node /app/.storage
WORKDIR /app/backend
USER node
CMD ["node", "dist/src/main.js"]
