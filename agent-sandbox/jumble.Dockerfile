FROM node:20-alpine AS builder

ARG VITE_COMMUNITY_RELAYS
ARG VITE_COMMUNITY_RELAY_SETS
# Pin the jumble revision for reproducibility; bump when we want new
# upstream. Matches the submodule SHA locally (`git submodule status`).
ARG JUMBLE_REV=6a17e1829ead933d386a0cb82f14e29b7a46bb19
ENV VITE_COMMUNITY_RELAYS=${VITE_COMMUNITY_RELAYS}
ENV VITE_COMMUNITY_RELAY_SETS=${VITE_COMMUNITY_RELAY_SETS}

# Clone upstream directly instead of relying on the git submodule, so
# platforms that clone without `--recurse-submodules` (e.g. Railway's
# GitHub integration) still have the source.
RUN apk add --no-cache git
WORKDIR /app
RUN git clone https://github.com/CodyTseng/jumble.git . \
 && git checkout ${JUMBLE_REV}
# Jumble's profile fetcher hits a hardcoded list of "big relays" (Damus,
# nos.lol, primal, offchain) BEFORE falling back to community relays. Our
# personas live only on our local strfry, so those upstream queries waste
# several seconds per profile load before the fallback kicks in. Rewrite
# the list to our community relay so profile lookups land on the first try.
RUN node -e 'const fs=require("fs"); const p="src/constants.ts"; const url=process.env.VITE_COMMUNITY_RELAYS; if(!url){console.error("VITE_COMMUNITY_RELAYS not set"); process.exit(1)} const before=fs.readFileSync(p,"utf8"); const after=before.replace(/export const BIG_RELAY_URLS = \[[\s\S]*?\]/, "export const BIG_RELAY_URLS = [\"" + url + "\"]"); if(before===after){console.error("BIG_RELAY_URLS pattern not found"); process.exit(1)} fs.writeFileSync(p,after); console.log("[jumble-patch] BIG_RELAY_URLS ->", url);'
RUN npm ci
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
# Jumble's SmartPool blocks ws:// URLs unless `allowInsecureConnection` is set.
# Our relay is local-only http/ws; inject the toggle so a fresh page load works
# without requiring users to flip it in Settings manually.
RUN sed -i 's|<head>|<head><script>try{localStorage.setItem("allowInsecureConnection","true")}catch(e){}</script>|' /usr/share/nginx/html/index.html
RUN printf 'server {\n  listen 80;\n  server_name localhost;\n  root /usr/share/nginx/html;\n  index index.html;\n  location / { try_files $uri $uri/ /index.html; }\n  location ~* \\.(?:js|css|woff2?|ttf|otf|eot|ico|jpg|jpeg|png|gif|svg|webp)$ {\n    expires 30d;\n    access_log off;\n    add_header Cache-Control "public";\n  }\n  gzip on;\n  gzip_types text/plain application/javascript application/x-javascript text/javascript text/css application/json;\n  gzip_min_length 1024;\n  gzip_comp_level 6;\n}\n' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
