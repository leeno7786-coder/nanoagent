FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY src/ ./src/
RUN bun run build

FROM oven/bun:1.3 AS run
WORKDIR /app
RUN groupadd -g 1001 nanoagent && \
    useradd -u 1001 -g nanoagent nanoagent
COPY --from=build --chown=nanoagent:nanoagent /app/dist ./dist
COPY --from=build --chown=nanoagent:nanoagent /app/node_modules ./node_modules
COPY package.json README.md ./
USER nanoagent
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--help"]
