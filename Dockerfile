# Multi-stage: TypeScript build, then Debian slim runtime with Playwright Chromium.
# Cloud Run needs Chromium OS deps — alpine cannot host a reliable browser.

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app

ARG GIT_COMMIT_SHA=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=latest

# Playwright browsers live outside node_modules so the path is stable in the image.
ENV NODE_ENV=production \
    BROWSER_WORKER_MODE=auto \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
    GIT_BRANCH=$GIT_BRANCH \
    BUILD_TIME=$BUILD_TIME \
    IMAGE_TAG=$IMAGE_TAG

# Minimal tools; Chromium system libs come from `playwright install --with-deps`.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN APP_VERSION=$(node -p "require('./package.json').version") && \
    BUILD_TS="${BUILD_TIME:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}" && \
    printf '{"gitCommit":"%s","gitBranch":"%s","buildTime":"%s","imageTag":"%s","appVersion":"%s"}\n' \
    "$GIT_COMMIT_SHA" "$GIT_BRANCH" "$BUILD_TS" "$IMAGE_TAG" "$APP_VERSION" > /app/build-info.json

RUN npm ci --omit=dev \
    && npx playwright install --with-deps chromium \
    && rm -rf /root/.npm /tmp/*

COPY --from=builder /app/dist ./dist

# Non-root is preferred on Cloud Run; chromium already launched with --no-sandbox.
RUN useradd --create-home --shell /bin/bash appuser \
    && chown -R appuser:appuser /app /ms-playwright
USER appuser

EXPOSE 5000
CMD ["node", "dist/app.js"]
