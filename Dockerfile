FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY scripts/ ./scripts/
COPY src/ ./src/
RUN bun run build

FROM oven/bun:1.3 AS run
WORKDIR /app
RUN groupadd -g 1001 nanoagent && \
    useradd -u 1001 -g nanoagent nanoagent
COPY --from=build --chown=nanoagent:nanoagent /app/dist ./dist
COPY --from=build --chown=nanoagent:nanoagent /app/node_modules ./node_modules
COPY package.json README.md ./
# The agent requires a canonical install root with the full subdir layout
# (the launcher normally creates it). Provide it in-image since the
# entrypoint is dist/main.js directly.
ENV NANOAGENT_ROOT=/data/nanoagent
RUN mkdir -p "$NANOAGENT_ROOT/config" "$NANOAGENT_ROOT/skills" "$NANOAGENT_ROOT/tools" \
             "$NANOAGENT_ROOT/sessions" "$NANOAGENT_ROOT/workspace" "$NANOAGENT_ROOT/logs" && \
    chown -R nanoagent:nanoagent /data
COPY --chown=nanoagent:nanoagent skills/ "$NANOAGENT_ROOT/skills/"
USER nanoagent
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--help"]
