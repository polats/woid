FROM node:20-slim

RUN apt-get update && apt-get install -y git jq curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi coding agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Bridge dependencies
COPY package.json package-lock.json* /app/bridge/
RUN cd /app/bridge && npm install --production

# Copy the rest of the bridge source. .dockerignore keeps node_modules,
# tests, .git, .env, etc. out of the image so adding a new module is
# zero-config — drop the file in this directory and rebuild.
COPY . /app/bridge/

RUN mkdir -p /workspace

ENV PORT=3457
ENV WORKSPACE=/workspace
ENV PI_BIN=pi

EXPOSE 3457
WORKDIR /app/bridge
CMD ["node", "server.js"]
