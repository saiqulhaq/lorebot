FROM oven/bun:1

WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY agent ./agent

ENV DATA_DIR=/data
VOLUME /data

CMD ["bun", "run", "src/index.ts"]
