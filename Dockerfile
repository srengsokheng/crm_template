# Acme CRM — one image: the API (Node runs the TypeScript directly) serving the built web app.
# Build:  docker build -t acme-crm .
# Run:    see docker-compose.prod.yml and docs/DEPLOY.md
FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:26.13.0-bookworm-slim
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY apps/api/src apps/api/src
COPY packages/shared packages/shared
COPY --from=build /app/apps/web/dist apps/web/dist
# Attachments on disk (when FILES_STORAGE isn't s3): mount a volume here.
RUN mkdir -p /app/data/files && chown -R node:node /app/data
ENV FILES_DIR=/app/data/files
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
# Runs migrations on start, then serves /api/v1 and the web app, and runs background jobs.
CMD ["node", "apps/api/src/server.ts"]
