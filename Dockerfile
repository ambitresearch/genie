# genie — multi-arch (amd64/arm64) Docker image (M5-07, DRO-279)
#
# Two-stage build: `build` compiles the pnpm workspace with full devDependencies,
# `runtime` copies ONLY the compiled @genie/server package + its production
# node_modules into a slim, non-root Alpine image (AC1/AC2/AC3).
#
# Build (single-arch, local):
#   docker build -t genie:local .
#
# Build + push (multi-arch, CI):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t docker.io/roshangautam/genie:X.Y.Z \
#     -t ghcr.io/roshangautam/genie:X.Y.Z \
#     --push .

# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS build

# Enable corepack so the pinned pnpm version (package.json "packageManager")
# resolves without a separate install step.
RUN corepack enable

WORKDIR /repo

# Copy only the manifests needed to resolve the dependency graph first, so
# Docker's layer cache survives source-only edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json packages/server/package.json
COPY packages/viewer/package.json packages/viewer/package.json
COPY packages/e2e/package.json packages/e2e/package.json

RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages/server packages/server
COPY packages/viewer packages/viewer

# @genie/viewer's static/ assets are mirrored into the server's dist/ui by
# copy-viewer-assets.mjs (see packages/server/scripts) — build the viewer's
# TS first only if the server build needs its typings; the runtime image never
# depends on @genie/viewer at runtime (see docs/store/viewer-assets.ts), only
# on the copied static/ bytes.
RUN pnpm --filter @genie/viewer build
RUN pnpm --filter @genie/server build

# Stage a production-only install of @genie/server so the runtime stage never
# needs pnpm's content-addressable store (whose reflinks/hardlinks don't
# survive a plain `COPY` across build stages).
RUN mkdir -p /out && \
    cp -R packages/server/dist /out/dist && \
    cp packages/server/package.json /out/package.json && \
    cd /out && \
    npm install --omit=dev --omit=optional --ignore-scripts

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

# curl is required by the container HEALTHCHECK (AC4) and is not present in
# the base node:22-alpine image.
RUN apk add --no-cache curl

# node:22-alpine already ships a `node` user/group at uid/gid 1000 — reuse it
# rather than creating a new one, satisfying AC3 (non-root, UID 1000) with no
# extra layer.
RUN test "$(id -u node)" = "1000"

WORKDIR /app
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    GENIE_HOME=/data

RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "8080"]
