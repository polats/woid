FROM node:20-alpine AS builder

ARG VITE_COMMUNITY_RELAYS
ARG VITE_COMMUNITY_RELAY_SETS
ENV VITE_COMMUNITY_RELAYS=${VITE_COMMUNITY_RELAYS}
ENV VITE_COMMUNITY_RELAY_SETS=${VITE_COMMUNITY_RELAY_SETS}

WORKDIR /app
COPY jumble/package*.json ./
RUN npm ci
COPY jumble/ ./
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
RUN printf 'server {\n  listen 80;\n  server_name localhost;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n  location ~* \\.(?:js|css|woff2?|ttf|otf|eot|ico|jpg|jpeg|png|gif|svg|webp)$ {\n    expires 30d;\n    access_log off;\n    add_header Cache-Control "public";\n  }\n  gzip on;\n  gzip_types text/plain application/javascript application/x-javascript text/javascript text/css application/json;\n  gzip_min_length 1024;\n  gzip_comp_level 6;\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
