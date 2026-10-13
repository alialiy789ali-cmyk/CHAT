# ============================================================================
# API image — multi-stage, non-root, production dependencies only.
# Build context is the repository root (monorepo with npm workspaces).
# ============================================================================
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm NODE_ENV=production
WORKDIR /app
RUN apk add --no-cache tini

# ---------------------------------------------------------------- deps + build
FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace @sovereign/shared --workspace @sovereign/server --include-workspace-root

COPY packages/shared packages/shared
COPY apps/server apps/server
RUN npm run build -w @sovereign/shared && npm run build -w @sovereign/server

# Prune to production dependencies only (keeps the runtime image small).
RUN npm prune --omit=dev

# ---------------------------------------------------------------- runtime
FROM base AS runtime
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json /app/
COPY --from=build /app/packages/shared/package.json /app/packages/shared/
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/apps/server/package.json /app/apps/server/
COPY --from=build /app/apps/server/dist /app/apps/server/dist

WORKDIR /app/apps/server
# Migration SQL files are read at runtime, so they must be present in the image.
COPY apps/server/src/db/migrations /app/apps/server/src/db/migrations

ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0

# Run as a non-root user; the data dir is only needed when STORAGE_DRIVER=local.
RUN addgroup -S sovereign && adduser -S sovereign -G sovereign \
  && mkdir -p /app/apps/server/var && chown -R sovereign:sovereign /app
USER sovereign

EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
