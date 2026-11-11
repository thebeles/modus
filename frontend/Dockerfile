FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-v11,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=modus-kontur-pnpm-meta-v11,target=/root/.cache/pnpm,sharing=locked \
    pnpm --filter @kontur/web install --frozen-lockfile --prefer-offline --ignore-scripts
COPY backend/src/contracts.ts backend/src/contracts.ts
COPY frontend/ frontend/
RUN --mount=type=cache,id=modus-kontur-corepack,target=/root/.cache/node/corepack,sharing=locked pnpm --filter @kontur/web build

FROM nginx:1.28-alpine
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/frontend/dist /usr/share/nginx/html
