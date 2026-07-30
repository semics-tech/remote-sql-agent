# Control plane: REST API, worker hub, and the dashboard it serves.
#
# Multi-stage so the runtime image carries no build toolchain and no source.
# The dashboard is built in and served by the API process, so a deployment is
# one container plus Postgres.

FROM node:24-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /build

# Manifests first so a dependency layer survives source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages/protocol/package.json  packages/protocol/
COPY packages/server/package.json    packages/server/
COPY packages/worker/package.json    packages/worker/
COPY packages/dashboard/package.json packages/dashboard/
COPY tests/integration/package.json  tests/integration/

# better-sqlite3 has no prebuilt binary for every platform-and-Node combination
# this image is built on — arm64 in particular — and falls back to compiling
# from source, which slim has no toolchain for. It belongs to the worker, whose
# bundle marks it --external, so nothing here ever loads it; it is built purely
# because pnpm resolves the whole workspace.
#
# Installed in the build stage only, so none of it reaches the runtime image.
# Excluding the package instead would be tidier, but pnpm's CLI overrides for
# onlyBuiltDependencies do not take, and a toolchain that is thrown away is a
# smaller price than an install command nobody can predict the behaviour of.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# The worker is not part of this image, but pnpm resolves the whole workspace.
RUN pnpm install --frozen-lockfile

COPY packages/ packages/
COPY deploy/worker/ deploy/worker/

RUN pnpm --filter @remote-sql-agent/dashboard build

# The worker bundle and its installers are served by the control plane at
# /install.sh, /install.ps1 and /downloads/. Serving them from here rather than
# the internet is what makes the one-line install work on a segmented network:
# a SQL host can always reach the control plane, and usually cannot reach GitHub.
RUN pnpm --filter @remote-sql-agent/worker bundle \
 && mkdir -p /packages \
 && cp deploy/worker/bootstrap.ps1 deploy/worker/bootstrap.sh /packages/ \
 && mkdir -p /staging/linux \
 && cp packages/worker/dist/rsagent-worker.mjs /staging/linux/ \
 && cp deploy/worker/rsagent-worker.service /staging/linux/ \
 && tar -czf /packages/rsagent-worker-linux.tar.gz -C /staging/linux .

# Prune to production dependencies for the runtime stage.
# --legacy because the workspace does not use injected dependencies; without it
# pnpm refuses rather than guessing.
RUN pnpm --filter @remote-sql-agent/server --prod --legacy deploy /prod/server


FROM node:24-bookworm-slim AS runtime

# tini reaps zombies and forwards signals, so SIGTERM reaches Node and the
# graceful shutdown path actually runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /prod/server ./
COPY --from=build /build/packages/protocol       ./node_modules/@remote-sql-agent/protocol
COPY --from=build /build/packages/dashboard/dist ./dashboard
COPY --from=build /packages                      ./worker-packages

# tsx runs the TypeScript sources directly. The alternative is a bundling step
# for a server that starts once and runs for months; the startup cost is not
# worth the extra build complexity here.
ENV RSAGENT_DASHBOARD_DIR=/app/dashboard
ENV RSAGENT_WORKER_PACKAGE_DIR=/app/worker-packages
ENV RSAGENT_HTTP_HOST=0.0.0.0
ENV RSAGENT_HTTP_PORT=8080
ENV RSAGENT_GRPC_HOST=0.0.0.0
ENV RSAGENT_GRPC_PORT=8443

# Never run as root: a control plane that holds every job definition in the
# estate is not something to hand an easy escalation path.
USER node

EXPOSE 8080 8443

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.RSAGENT_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "src/index.ts"]
