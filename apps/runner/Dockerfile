# The cloud runner: takes automation runs and executes them with the Claude Agent SDK, billed to
# ANTHROPIC_API_KEY. Build from the repository root (it runs packages/shared and packages/client
# from source):
#   docker build -f apps/runner/Dockerfile .
FROM node:22-slim AS base
# Keep in step with `packageManager` in the root package.json.
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
WORKDIR /app
# Every workspace manifest, so pnpm sees the same workspace the lockfile was written for.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/runner/package.json apps/runner/
COPY apps/desktop/package.json apps/desktop/
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/

FROM base AS deps
# Production only: @lyfestyle/api is a dev dependency (the client takes only its types), and no
# install script is needed. The Agent SDK's Claude Code binary for this platform is an optional
# dependency the lockfile already lists.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @lyfestyle/runner...

FROM node:22-slim
ENV NODE_ENV=production
# A container has no claude.ai login, so connector tools (Gmail, Calendar) cannot load. Runs that
# need them belong to the desktop app's runner.
ENV AGENT_CONNECTOR_TOOLS=none
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/runner/node_modules apps/runner/node_modules
COPY --from=deps /app/packages/shared/node_modules packages/shared/node_modules
COPY --from=deps /app/packages/client/node_modules packages/client/node_modules
COPY tsconfig.base.json package.json ./
COPY packages/shared packages/shared
COPY packages/client packages/client
COPY apps/runner/package.json apps/runner/tsconfig.json apps/runner/
COPY apps/runner/src apps/runner/src
WORKDIR /app/apps/runner
# Claude Code keeps its settings and session transcripts under $HOME.
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
