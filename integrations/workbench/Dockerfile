# Build only integrations/workbench, never the repository or a target directory.
# Official multi-platform index verified on 2026-10-17; see docs/container.md.
FROM node:24.22.0-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base

# REA requires procps-compatible ps to establish ownership before child launch.
# Retain that check. This image deliberately omits external native decompilers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends --no-upgrade \
        libproc2-0=2:4.0.2-3 \
        procps=2:4.0.2-3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /evidence /targets \
    && chown 1000:1000 /evidence \
    && chmod 0700 /evidence

FROM base AS dependencies
WORKDIR /opt/rea-workbench
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund \
    && npm cache clean --force

FROM base AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="REA investigation workbench" \
      org.opencontainers.image.description="Local CLI and stdio MCP investigations with canonical evidence memory" \
      org.opencontainers.image.source="https://github.com/empire-mind/Reverse-Engineer" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="MIT"
WORKDIR /opt/rea-workbench
ENV NODE_ENV=production \
    REA_WORKBENCH_MEMORY=/evidence
COPY --from=dependencies /opt/rea-workbench/node_modules ./node_modules
COPY package.json package-lock.json README.md LICENSE ./
COPY bin ./bin
COPY lib ./lib
COPY --chmod=0555 scripts/container-entrypoint.sh ./scripts/container-entrypoint.sh
USER 1000:1000
ENTRYPOINT ["/opt/rea-workbench/scripts/container-entrypoint.sh"]
CMD ["status"]
