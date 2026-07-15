FROM node:22-alpine

WORKDIR /app

# Minimal package.json — oidc-provider is the only runtime dependency the
# bootstrap script needs. Pinned to the same major/minor genie's own
# devDependency uses (packages/e2e/package.json) to keep behavior identical
# between "what the fixture asserts against" and "what a real deployment
# would see" as closely as a container boundary allows.
RUN npm install --no-save oidc-provider@9.9.1

COPY server.mjs ./server.mjs

EXPOSE 9944

CMD ["node", "server.mjs"]
