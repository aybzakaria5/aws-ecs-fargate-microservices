# syntax=docker/dockerfile:1
# The Auth service has no npm dependencies (JWT is implemented with node:crypto),
# so there is no install stage and no node_modules to copy.
FROM node:22-alpine
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json ./
COPY src ./src
# Run as the unprivileged "node" user that ships with the base image
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
CMD ["node", "src/server.js"]
