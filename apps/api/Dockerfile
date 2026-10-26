# Build from the repository root: the API bundles packages/shared out of the pnpm workspace.
#   docker build -f apps/api/Dockerfile .
FROM node:26-slim AS base
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
# Every workspace manifest, so pnpm sees the same workspace the lockfile was written for.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter @lyfestyle/api...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @lyfestyle/api build

FROM base AS deps
RUN pnpm install --frozen-lockfile --prod --filter @lyfestyle/api...

FROM node:26-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY apps/api/package.json apps/api/
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
