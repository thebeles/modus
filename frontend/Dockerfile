FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=modus-corepack,target=/root/.cache/node/corepack,sharing=locked \
    --mount=type=cache,id=modus-pnpm-v11,target=/root/.local/share/pnpm/store,sharing=locked \
    --mount=type=cache,id=modus-pnpm-meta-v11,target=/root/.cache/pnpm,sharing=locked \
    pnpm install --frozen-lockfile --prefer-offline --ignore-scripts
COPY . .
RUN --mount=type=cache,id=modus-corepack,target=/root/.cache/node/corepack,sharing=locked pnpm build

FROM nginx:1.28-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
