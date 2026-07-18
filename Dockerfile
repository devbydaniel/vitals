FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runner
RUN addgroup -g 1001 -S app && adduser -S app -u 1001
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
# --ignore-scripts: skips the husky "prepare" hook (a dev dependency)
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --chown=app:app migrations ./migrations
COPY --from=builder --chown=app:app /app/dist ./dist
USER app
# Apply migrations, then run the nightly sync (used by the K8s CronJob).
CMD ["sh", "-c", "npx node-pg-migrate up -m migrations && node dist/cli/sync.js"]
