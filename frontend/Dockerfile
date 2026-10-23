# Multi-stage build: compile the Vite app, then serve the static output with an unprivileged nginx. The final image
# contains no Node.js runtime or source code — only the built assets and nginx.
FROM node:22-slim AS build
WORKDIR /app
# Playwright (an e2e devDependency) must not download browsers into the build stage.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
# npm skips an optional dependency whose download fails (npm/cli#4828), which would leave Vite without its native
# bundler binding and cache that broken layer; loading Vite here fails the step instead, so a retry reinstalls.
RUN npm ci && node --input-type=module -e "await import('vite')"
COPY . .
ARG VITE_API_BASE_URL=/api
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
# Institution name and approved logo URL for the portal header and sign-in screen (frontend/BRANDING.md).
ARG VITE_INSTITUTION_NAME="Graphic Era"
ARG VITE_BRAND_LOGO_URL=""
ENV VITE_INSTITUTION_NAME=$VITE_INSTITUTION_NAME
ENV VITE_BRAND_LOGO_URL=$VITE_BRAND_LOGO_URL
RUN npm run build

# nginx-unprivileged runs as the non-root `nginx` user (uid 101) and therefore listens on 8080, not 80.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
