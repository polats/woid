FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY src/ ./src/
ENV PORT=2567
EXPOSE 2567
CMD ["node", "src/index.js"]
