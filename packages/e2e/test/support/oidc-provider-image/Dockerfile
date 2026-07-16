FROM node:22-alpine

WORKDIR /app

# oidc-provider is the fixture's only runtime dependency. Keep the version
# explicit so provider behavior changes are reviewed deliberately.
RUN npm install --no-save oidc-provider@9.9.1

COPY server.mjs ./server.mjs

EXPOSE 9944

CMD ["node", "server.mjs"]
