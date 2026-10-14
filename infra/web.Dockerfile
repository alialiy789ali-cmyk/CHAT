# ============================================================================
# Web image — Next.js standalone build served by the project's custom server,
# which also proxies /api and /ws to the API container (single public origin).
# ============================================================================
FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache tini

FROM base AS build
ENV NODE_ENV=development
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/server/package.json apps/server/
RUN npm ci --workspace @sovereign/shared --workspace @sovereign/web --include-workspace-root

COPY packages/shared packages/shared
COPY apps/web apps/web
# The shared protocol/validation package must be built before Next compiles the client.
RUN npm run build -w @sovereign/shared && npm run build -w @sovereign/web
RUN npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.base.json /app/
COPY --from=build /app/packages/shared/package.json /app/packages/shared/
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/apps/web/package.json /app/apps/web/
COPY --from=build /app/apps/web/.next /app/apps/web/.next
COPY --from=build /app/apps/web/public /app/apps/web/public
COPY apps/web/server.ts apps/web/tsconfig.json apps/web/next.config.ts /app/apps/web/

WORKDIR /app/apps/web
ENV PORT=3000 \
    HOSTNAME_BIND=0.0.0.0 \
    API_URL=http://api:8787

RUN addgroup -S web && adduser -S web -G web && mkdir -p /app/apps/web/.next/cache && chown -R web:web /app
USER web

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# The runtime needs tsx to execute the TypeScript custom server (compiled server.js also works).
CMD ["npx", "tsx", "server.ts"]
