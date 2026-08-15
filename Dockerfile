FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app

ARG GIT_COMMIT_SHA=unknown
ARG GIT_BRANCH=unknown
ARG BUILD_TIME=unknown
ARG IMAGE_TAG=latest

ENV NODE_ENV=production \
    GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
    GIT_BRANCH=$GIT_BRANCH \
    BUILD_TIME=$BUILD_TIME \
    IMAGE_TAG=$IMAGE_TAG

COPY package.json package-lock.json* ./
RUN APP_VERSION=$(node -p "require('./package.json').version") && \
    printf '{"gitCommit":"%s","gitBranch":"%s","buildTime":"%s","imageTag":"%s","appVersion":"%s"}\n' \
    "$GIT_COMMIT_SHA" "$GIT_BRANCH" "$BUILD_TIME" "$IMAGE_TAG" "$APP_VERSION" > /app/build-info.json
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist
EXPOSE 5000
CMD ["node", "dist/app.js"]
