# syntax=docker/dockerfile:1

# Build context is THIS directory, not the monorepo root:
#
#     docker build -t cheela-search-api apps/search-api
#
# apps/search-api mirrors to its own repo (tooling/subtree.sh), where this file
# sits at the repo root and the context is the whole repo. Nothing outside this
# directory may be referenced, or the mirror stops building.
#
# That is possible because this app depends on nothing by `workspace:` and
# because apps/search-api/tsconfig.json is self-contained rather than extending
# tooling/tsconfig. Keep both properties intact — `verify-standalone.mjs` fails
# the build if the first one breaks.
#
# On Cloud Build pointed at the mirror: Dockerfile at `/Dockerfile`, context `/`.

FROM node:22-alpine AS base

ENV CI=true

RUN corepack enable \
    && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app

# pnpm 11 reads settings from pnpm-workspace.yaml, not package.json or .npmrc,
# and aborts with ERR_PNPM_IGNORED_BUILDS if a dependency has a build script
# that no policy either allows or explicitly ignores. esbuild has one, and tsup
# pulls it in, so without this block the build fails at install. The workspace
# root's copy is not in the mirror, so reproduce it here — generated rather than
# committed, because a pnpm-workspace.yaml inside apps/search-api would make
# pnpm treat it as a nested workspace root within the monorepo.
#
# Keep in step with allowBuilds in the workspace root's pnpm-workspace.yaml.
COPY <<-'YAML' pnpm-workspace.yaml
	allowBuilds:
	  '@google/genai': true
	  browser-tabs-lock: false
	  esbuild: false
	  protobufjs: false
	  sharp: true
	  workerd: false
YAML

# ------------------------------------------------------------
# Install dependencies
#
# Manifest only, so this layer is cached until package.json changes — source
# edits don't re-run the install.
#
# The workspace's pnpm-lock.yaml lives at the monorepo root and is not part of
# the mirror, so there is no lockfile to honour and --no-frozen-lockfile is
# required. Dependencies resolve at build time within the semver ranges in
# package.json; pin them exactly if a build needs to be reproducible.
# ------------------------------------------------------------
FROM base AS deps

COPY package.json ./

RUN pnpm install --no-frozen-lockfile

# ------------------------------------------------------------
# Build
# ------------------------------------------------------------
FROM base AS build

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm build

# ------------------------------------------------------------
# Production dependencies
#
# Resolved separately rather than pruned, so the runner gets a tree that never
# contained tsup, tsx, vitest or typescript.
# ------------------------------------------------------------
FROM base AS prod-deps

COPY package.json ./

RUN pnpm install --prod --no-frozen-lockfile

# ------------------------------------------------------------
# Runtime
# ------------------------------------------------------------
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# `"type": "module"` lives here — without it Node reads dist/index.js as CJS.
COPY package.json ./

# Don't run as root.
USER node

# Cloud Run injects PORT and ignores EXPOSE; this is for every other host and
# for `docker run -P` locally. src/shared/config.ts defaults to the same value.
EXPOSE 3006

# Cloud Run runs its own startup and liveness probes and ignores this. Kept for
# local runs and for any host that reads it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3006)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
