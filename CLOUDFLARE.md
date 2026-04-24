## Gotchas

### Cloudflare

- **`/user/tokens/verify` lies for scoped tokens.** A least-privilege token (e.g. `Zone:DNS:Edit` scoped to a single zone) returns `{"success": false, "errors": [{"code": 1000, "message": "Invalid API Token"}]}` on `/client/v4/user/tokens/verify`. That endpoint requires **User**-level scope the token doesn't have — it is NOT a validity check for scoped tokens. Do not use it to gate automation. The token is fine; only the probe is wrong.

- **Correct validity test** — hit an endpoint the token is actually scoped for. For our zone token:
  ```bash
  curl -s -H "Authorization: Bearer $CLOUDFLARE_TOKEN" \
    https://api.cloudflare.com/client/v4/zones
  ```
  `success: true` + a zone array means the token works. If you need to confirm write access without side effects, create a throwaway CNAME (e.g. `__probe.noods.cc` → `probe.invalid`) and delete it immediately — see `noods.cc` zone `d41fdeec4e58d62a742e23805ab6f31a`.

- **API Token vs Global API Key format** — both are ~40 chars, easy to confuse. API Tokens are mixed-case alphanumeric and use `Authorization: Bearer <token>`. Global API Keys are lowercase hex and use `X-Auth-Email` + `X-Auth-Key`. Testing an API Token with `X-Auth-Key` yields `code 6103: Invalid format for X-Auth-Key header` — a distinct tell.

- **noods.cc zone ID** — `d41fdeec4e58d62a742e23805ab6f31a`. Cache this; every DNS API call needs it. Retrieve via `GET /zones?name=noods.cc` if lost.

## Cloudflare API Cheatsheet

```bash
# Auth (scoped Zone:DNS:Edit token)
CT=$(grep CLOUDFLARE_TOKEN .env | cut -d= -f2)
AUTH="Authorization: Bearer $CT"
ZONE=d41fdeec4e58d62a742e23805ab6f31a

# List DNS records for noods.cc
curl -s -H "$AUTH" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records?per_page=100"

# Create CNAME (woid.noods.cc -> vercel.app target, DNS-only)
curl -s -H "$AUTH" -H "Content-Type: application/json" -X POST \
  -d '{"type":"CNAME","name":"woid","content":"cname.vercel-dns.com","ttl":1,"proxied":false}' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records"

# Upsert helper — look up by name, PATCH if exists else POST.
# (Cloudflare has no built-in upsert; roll your own.)

# Delete a record
curl -s -X DELETE -H "$AUTH" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records/<record_id>"
```

### When to proxy (orange-cloud) vs DNS-only

- **DNS-only (grey-cloud, `"proxied": false`)** — default for WebSocket services (`relay.woid.noods.cc`, `rooms.woid.noods.cc`) until you've explicitly verified Cloudflare's WS proxy doesn't break the protocol. Colyseus, strfry, and raw-socket bridges all behave more predictably without the proxy in the path.
- **Proxied (orange-cloud, `"proxied": true`)** — safe for the static Vercel frontend (`woid.noods.cc`) and any plain-HTTPS services (`bridge.woid.noods.cc` if you want CDN + DDoS in front of the JSON API). Turn on only after the DNS-only version is known-good.
