# syntax=docker/dockerfile:1
# Realtydoor API image (Express + Prisma + MongoDB).
# Build:  docker build -t realtydoor-api .
# Run:    docker run -p 5000:5000 --env-file <your env file> realtydoor-api      (settings: see .env.example; secrets never go in the image)
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
# Prisma's query engine needs OpenSSL, and the client must be generated on the same Linux family the image runs on.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY prisma ./prisma
# `npm ci` runs the postinstall step (`prisma generate`), which needs the prisma CLI (a dev dependency) and the schema folder above.
RUN npm ci
# Keep only what the API needs at runtime; the generated client (node_modules/.prisma) stays.
RUN npm prune --omit=dev

FROM node:${NODE_VERSION}-bookworm-slim AS run
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=5000
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node scripts ./scripts
USER node
EXPOSE 5000
# Scheduled jobs run on every task unless RUN_JOBS=false: with more than one task, exactly one must keep them on.
# The load balancer health check should use GET /health (or /api/health); this is the same check for plain Docker.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
