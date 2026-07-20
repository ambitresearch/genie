# genie — multi-arch (amd64/arm64) Docker image (M5-07, DRO-279)
#
# Two-stage build: `build` compiles the pnpm workspace with full devDependencies,
# `runtime` copies ONLY the compiled @ambitresearch/genie package + its production
# node_modules into a slim, non-root Alpine image (AC1/AC2/AC3).
#
# Build (single-arch, local):
#   docker build -t genie:local .
#
# Build + push (multi-arch, CI):
#   docker buildx build --platform linux/amd64,linux/arm64 \
#     -t docker.io/ambitresearch/genie:X.Y.Z \
#     -t ghcr.io/ambitresearch/genie:X.Y.Z \
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

# @ambitresearch/genie-viewer's static/ assets are mirrored into the server's dist/ui by
# copy-viewer-assets.mjs (see packages/server/scripts) — build the viewer's
# TS first only if the server build needs its typings; the runtime image never
# depends on @ambitresearch/genie-viewer at runtime (see packages/server/src/store/viewer-assets.ts), only
# on the copied static/ bytes.
RUN pnpm --filter @ambitresearch/genie-viewer build
RUN pnpm --filter @ambitresearch/genie build

# ts-morph publishes a large CommonJS graph containing a full TypeScript
# compiler. Bundle only the two runtime exports used by the framework adapters
# into one minified ESM module before pruning the original graph.
RUN node -e "const fs=require('node:fs');const entry=require.resolve('ts-morph',{paths:['/repo/packages/server']});fs.writeFileSync('/tmp/ts-morph-entry.mjs','export { Project, ts } from '+JSON.stringify(entry)+';\n')" && \
    node -e "const {build}=require(require.resolve('esbuild',{paths:['/repo/packages/server']}));build({entryPoints:['/tmp/ts-morph-entry.mjs'],bundle:true,platform:'node',format:'esm',target:'node22',outfile:'/tmp/ts-morph-runtime.mjs',minify:true,legalComments:'inline'})"

# Deploy the built server with production dependencies resolved from the frozen
# workspace lockfile. Legacy deploy still performs a resolution pass, so disable
# minimumReleaseAge for this command only; `--frozen-lockfile` keeps every
# selected artifact pinned to the reviewed lockfile. `--legacy` is required
# because this workspace intentionally does not use pnpm's injected-workspace-
# packages mode; the deployed runtime has no workspace dependency after
# devDependencies are omitted.
#
# Source maps, declarations, package tests/examples/docs, and duplicate
# TypeScript source are build-time/publisher payload, not runtime inputs.
# Removing them from /out before the final COPY keeps the node:22-alpine image
# below AC2's 200,000,000-byte ceiling. Optional dependencies stay installed because
# esbuild's native per-platform binary is one of them and is required by the
# preview bundler at runtime.
RUN pnpm --filter @ambitresearch/genie deploy --prod --legacy --frozen-lockfile --config.minimumReleaseAge=0 /out && \
    node -e "const fs=require('node:fs');const path=require('node:path');const root='/out/node_modules/.pnpm';const dir=fs.readdirSync(root).find((name)=>name.startsWith('ts-morph@'));const commonDir=fs.readdirSync(root).find((name)=>name.startsWith('@ts-morph+common@'));if(!dir||!commonDir)throw new Error('deployed ts-morph graph not found');const packageRoot=path.join(root,dir,'node_modules/ts-morph');fs.copyFileSync('/tmp/ts-morph-runtime.mjs',path.join(packageRoot,'dist/runtime.mjs'));fs.copyFileSync(path.join(root,commonDir,'node_modules/@ts-morph/common/LICENSE'),path.join(packageRoot,'LICENSE.@ts-morph-common'));const file=path.join(packageRoot,'package.json');const manifest=JSON.parse(fs.readFileSync(file,'utf8'));manifest.type='module';manifest.main='./dist/runtime.mjs';manifest.exports={'.':'./dist/runtime.mjs'};fs.writeFileSync(file,JSON.stringify(manifest))" && \
    node packages/server/scripts/pack-ts-morph-runtime.mjs /out/node_modules/ts-morph/dist/runtime.mjs && \
    find /out/node_modules -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \
         -o -iname '*.md' -o -iname '*.markdown' \) \
      ! -iname 'license*' ! -iname 'licence*' ! -iname 'copying*' ! -iname 'notice*' \
      -delete && \
    find /out/node_modules -type d \
      \( -name test -o -name tests -o -name __tests__ -o -name coverage \
         -o -name benchmark -o -name benchmarks -o -name example -o -name examples \) \
      -prune -exec rm -rf '{}' + && \
    rm -rf \
      /out/node_modules/.pnpm/@ts-morph+common@* \
      /out/node_modules/.pnpm/@aws-sdk+* \
      /out/node_modules/.pnpm/@aws+lambda-invoke-store@* \
      /out/node_modules/.pnpm/@smithy+* \
      /out/node_modules/.pnpm/openai@*/node_modules/openai/src \
      /out/node_modules/.pnpm/zod@*/node_modules/zod/src \
      /out/node_modules/.pnpm/parse5@*/node_modules/parse5/dist/cjs \
      /out/node_modules/.pnpm/@modelcontextprotocol+sdk@*/node_modules/@modelcontextprotocol/sdk/dist/cjs && \
    rm -f /out/node_modules/.pnpm/ts-morph@*/node_modules/ts-morph/dist/ts-morph.js && \
    find /out/node_modules/.pnpm/openai@*/node_modules/openai -type f -name '*.js' -delete && \
    find /out/node_modules/.pnpm/zod@*/node_modules/zod -type f -name '*.cjs' -delete && \
    find /out/node_modules/.pnpm -type f \
      \( -name '*.ts' -o -name '*.flow' -o -name '*.tsbuildinfo' \) -delete && \
    rm -f \
      /out/node_modules/.pnpm/@vue+compiler-sfc@*/node_modules/@vue/compiler-sfc/dist/compiler-sfc.esm-browser.js \
      /out/node_modules/.pnpm/pngjs@*/node_modules/pngjs/browser.js

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
COPY --chown=node:node LICENSE ./LICENSE

ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    GENIE_HOME=/data \
    GENIE_KITS_ROOT=/data/kits \
    GENIE_PROJECTS_ROOT=/data/projects \
    GENIE_REPORTS_DIR=/data/reports

RUN mkdir -p /data/kits /data/projects /data/reports && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--transport", "http", "--host", "0.0.0.0", "--port", "8080"]
