# Backend production image. There are no devDependencies, so a single stage installs exactly what runs.
# Node 22 LTS: file-type 22 needs Node >= 22, and Node 20 left support in April 2026.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production

# No ClamAV package is needed: backend/src/antivirus.js speaks the clamd protocol directly over TCP
# (CLAMD_HOST/CLAMD_PORT, e.g. the `clamav` service in docker-compose.prod.yml).

# Reproducible install from the lockfile only. The xlsx parser comes from the SheetJS CDN tarball pinned (with its
# integrity hash) in package-lock.json, so the build needs outbound HTTPS to cdn.sheetjs.com as well as npm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Source stays owned by root (read-only for the app); only uploads/ is writable by the unprivileged `node` user
# (uid 1000, from the base image). Mount the uploads volume there; k8s sets fsGroup 1000 for the same reason.
COPY . .
RUN mkdir -p uploads && chown node:node uploads
USER node

EXPOSE 4000

# Liveness only (process up, no dependencies), so a database or Redis outage never marks the container unhealthy.
# Readiness is /api/health/ready (docker-compose.prod.yml's healthcheck and the k8s readinessProbe use it).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 4000) + '/api/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# No default CMD runs migrations automatically on every boot — that's a
# deliberate choice: schema migrations should be an explicit, observable
# step (see docker-compose.prod.yml's migrate service), not something that
# silently happens as a side effect of a pod restarting.
CMD ["node", "src/server.js"]
