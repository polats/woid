# Woid agent-sandbox Nostr relay. Built on strfry (same as apoc-radio-v2
# and npc-no-more). No pubkey whitelist — writes are open. Intended for
# localhost-only sandbox use; do not expose without a write-policy plugin.
FROM dockurr/strfry:latest

COPY strfry.conf /etc/strfry.conf
WORKDIR /app
RUN mkdir -p /app/strfry-db

EXPOSE 7777
CMD ["/app/strfry", "--config=/etc/strfry.conf", "relay"]
