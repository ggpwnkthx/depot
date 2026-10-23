# syntax=docker/dockerfile:1

# The version of the runtime and the revision of the build are labels of the
# image: an operator has to know what is running without reading the logs.
#
# The base image is pinned by digest: a tag is a name that moves, and the
# image of a release has to be the image that was built and scanned.
ARG BUN_VERSION=1.4.3
ARG BUN_DIGEST=sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373
ARG VERSION=0.3.1
ARG REVISION=unknown

# ---------------------------------------------------------------- dependencies
#
# The dependencies of the service alone. The development dependencies (the
# types of the tests) are not part of the image of the service.
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS runtime-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production && \
    rm -rf /root/.bun/install/cache

# ------------------------------------------------------------------- runtime
#
# The production image contains the service and nothing else. There is no
# secret in it: the credentials of the database, of the hub and of the
# signature are files that the deployment mounts, and they are read at the
# start of the process.
FROM oven/bun:${BUN_VERSION}-alpine@${BUN_DIGEST} AS runtime
WORKDIR /app

ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.title="depot" \
      org.opencontainers.image.description="A headless, permission aware data API: it owns the workspaces, the collections, the policies, the records, the audit and the events." \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/ggpwnkthx/depot" \
      org.opencontainers.image.licenses="MIT"

ENV DATA_ENVIRONMENT=production \
    DATA_HOST=0.0.0.0 \
    DATA_PORT=8082 \
    DATA_PROCESS_ROLE=all \
    DATA_SCHEMA_BUNDLE_FILE=/app/manifests/schema.json \
    DATA_POLICY_BUNDLE_FILE=/app/manifests/policies.json

COPY --from=runtime-deps /app/node_modules ./node_modules
COPY src ./src
COPY scripts ./scripts
COPY manifests ./manifests
COPY migrations ./migrations
COPY package.json ./

# The service runs as a user that is not root: a container that is root on
# the host of the container is root on the host.
USER bun
EXPOSE 8082

# The service writes nothing: the logs go to the standard output, and the
# file system of the container can be read-only. The bindings of the
# gateway, the manifests and the credentials are mounted read-only.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8082/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

ENTRYPOINT ["bun", "run"]
CMD ["src/main.ts"]
