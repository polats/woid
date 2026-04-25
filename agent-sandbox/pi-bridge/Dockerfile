FROM node:20-slim

RUN apt-get update && apt-get install -y git jq curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install pi coding agent globally
RUN npm install -g @mariozechner/pi-coding-agent

# Bridge dependencies
COPY package.json package-lock.json* /app/bridge/
RUN cd /app/bridge && npm install --production

COPY server.js prompt-builder.js buildContext.js sessionReader.js room-client.js s3.js pi-pool.js rate-limiter.js api-quota.js persona-log.js nim-catalog.json gemini-catalog.json local-catalog.json /app/bridge/
COPY skill-templates/ /app/bridge/skill-templates/
COPY harnesses/ /app/bridge/harnesses/
COPY providers/ /app/bridge/providers/

RUN mkdir -p /workspace

ENV PORT=3457
ENV WORKSPACE=/workspace
ENV PI_BIN=pi

EXPOSE 3457
WORKDIR /app/bridge
CMD ["node", "server.js"]
