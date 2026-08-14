# syntax=docker/dockerfile:1

# Terrace — one Dockerfile, two final targets:
#
#   --target server  Node 24 running the Colyseus world server straight from
#                    TypeScript source (no compile step — see below).
#   --target client  nginx serving the Vite-built browser client.
#
# docker-compose.yml builds both; README.md has the self-host quickstart.
# BuildKit is required (cache mounts + heredocs): Docker Engine 23+ / Compose v2.

# Node 24 is not optional: the server runs `.ts` files directly via Node's
# built-in type stripping (design record, "Version facts"), so there is no dist/
# for the server half and no tsc in the runtime image.
#
# bookworm-slim (glibc) rather than alpine (musl): better-sqlite3 13 ships
# prebuilt bindings for both, but glibc is the better-tested path and neither
# needs a native toolchain in the image — verified: better-sqlite3 13.0.3 has no
# install script and carries prebuilds/linux-x64.node in the package itself.
#
# Both tags are pinned to a major line, not a patch: a self-hoster's rebuild
# should pick up security fixes, and the code's real requirement is "Node 24".
# Override either with `--build-arg` to pin harder.
ARG NODE_IMAGE=node:24-bookworm-slim
ARG NGINX_IMAGE=nginx:1-alpine

# ---------------------------------------------------------------------------
# base — pnpm, non-interactive, one workdir for every stage
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base

# Corepack installs the exact pnpm from package.json "packageManager", so the
# version is never duplicated here.
RUN corepack enable

# CI=true and the prompt opt-out: nothing in an image build may wait on a TTY.
# (Without CI=true, pnpm aborts with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY
# whenever it wants to re-create node_modules — reproduced locally.)
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    npm_config_store_dir=/pnpm/store

WORKDIR /app

# ---------------------------------------------------------------------------
# source — the whole workspace in one layer
# ---------------------------------------------------------------------------
# Copying each package.json first would cache installs better, but
# pnpm-workspace.yaml globs `plugins/*`: a self-hoster who drops in a plugin
# folder must be picked up without editing this file. The pnpm store cache mount
# below keeps the re-install cheap (~10 s) when only source changed.
FROM base AS source
COPY . .

# ---------------------------------------------------------------------------
# client-build — vite build
# ---------------------------------------------------------------------------
FROM source AS client-build

# Vite inlines `import.meta.env.VITE_*` at BUILD time (verified: building with
# VITE_SERVER_URL set puts the literal string in dist/assets/*.js). So the
# endpoint a browser dials is baked into the bundle — changing it means
# rebuilding this image, which is what `docker compose up --build` does.
ARG VITE_SERVER_URL
ARG VITE_ROOM_NAME

# Full install: the client needs its dev dependencies (vite, the solid plugin).
RUN --mount=type=cache,id=terrace-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --filter @terrace/client build

# ---------------------------------------------------------------------------
# client — static hosting of the built bundle
# ---------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS client

# The core server speaks Colyseus only — it serves no static files (verified:
# server/src/index.ts creates a bare Colyseus Server and defines one room). So
# the client is served by its own tiny nginx layer rather than by the server.
COPY --from=client-build /app/client/dist /usr/share/nginx/html

# conf.d is included inside nginx's http block, so this adds gzip without
# touching the image's default server block. Worth it: the bundle is ~670 KB
# raw, ~180 KB gzipped (measured on a production build).
COPY <<'EOF' /etc/nginx/conf.d/terrace-gzip.conf
gzip on;
gzip_types text/css application/javascript application/json image/svg+xml;
gzip_min_length 1024;
EOF

EXPOSE 80

# ---------------------------------------------------------------------------
# server-deps — runtime-only dependency tree
# ---------------------------------------------------------------------------
# --filter @terrace/server... takes the server plus the workspace packages it
# depends on (shared/); --prod drops typescript/vitest/@types, which the runtime
# never loads because Node strips the types itself. Verified locally: 181
# packages instead of 275, and `node server/src/index.ts` still boots.
FROM source AS server-deps
RUN --mount=type=cache,id=terrace-pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @terrace/server... --prod

# ---------------------------------------------------------------------------
# server — the world process
# ---------------------------------------------------------------------------
FROM base AS server

ENV NODE_ENV=production

# Copied wholesale because pnpm's layout is symlink-based
# (server/node_modules/@terrace/shared -> ../../shared) and those links must
# land intact. `pnpm deploy` is deliberately NOT used: it would materialise
# shared/ INSIDE node_modules, and Node refuses to type-strip TypeScript found
# under node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING) — the server
# would not start.
COPY --from=server-deps --chown=node:node /app /app

# The world database lives on a volume. Creating the directories here, owned by
# the unprivileged `node` user, is what makes a fresh named volume come up
# writable (Docker seeds a new named volume from the image's directory,
# ownership included). A bind mount does NOT get that treatment — see README.
#
# Two directories, because DB_PATH has two conventional spellings: /data/world.db
# (the Docker one) and ./data/world.db (the repo-relative one in .env.example,
# which resolves to /app/data here). Compose mounts the SAME volume at both, so
# either spelling persists to the same world instead of writing a database into
# the container's disposable layer.
RUN mkdir -p /data /app/data && chown node:node /data /app/data
ENV DB_PATH=/data/world.db

USER node

# Colyseus's conventional port; PORT overrides it (compose maps the same number
# on both sides so the two never disagree).
EXPOSE 2567

# Type stripping needs no flag on Node 24 — verified with node v24.18.
CMD ["node", "server/src/index.ts"]
