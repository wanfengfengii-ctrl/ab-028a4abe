# syntax=docker/dockerfile:1

# ---- build stage: dependencies, TypeScript build, unit tests ----
FROM node:22-alpine AS build
WORKDIR /app

# Install dependencies first for better layer caching.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

# Bake the test result into the image; a failing test fails the build.
RUN npm test

# ---- runtime stage: minimal, non-root, compiled output only ----
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV API_PORT=3000

# The service uses only Node.js built-in modules, so no node_modules are
# needed at runtime.
COPY package.json ./
COPY --from=build /app/dist ./dist

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

EXPOSE 3000

# Container-level health check; the application also serves GET /healthz.
HEALTHCHECK --interval=5s --timeout=3s --start-period=4s --retries=12 \
  CMD node /app/dist/src/healthcheck.js

# ---- verification stage: full toolchain + sources + one-shot entrypoint ----
FROM build AS verify
WORKDIR /app
COPY scripts ./scripts
# Waits for API health, then re-checks the TypeScript build, the unit tests
# and the cross-week HTTP smoke; exits non-zero on the first failure.
CMD ["node", "scripts/verify.mjs"]
