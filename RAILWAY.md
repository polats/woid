## Gotchas

### Railway

- **Railway CLI token** — the `RAILWAY_TOKEN` in `.env` works with the GraphQL API (`https://backboard.railway.app/graphql/v2`) but NOT with the Railway CLI. The CLI needs a different auth flow (`railway login`). Always use GraphQL for automation.

- **`me.projects` lies** — `{ me { projects { edges { node { ... } } } } }` returns `[]` for accounts whose projects live in a workspace (which is every account created after the workspaces migration). Use `{ me { workspaces { id } } }` to find your workspace, then `{ projects }` at the root query. The token's visibility scope determines what projects appear.

- **`projectCreate` needs `workspaceId`** — omitting it gives a misleading `INTERNAL_SERVER_ERROR` with `"You must specify a workspaceId to create a project"` buried in the error message. Always include it:
  ```graphql
  mutation { projectCreate(input: { name: "…", workspaceId: "…" }) { id } }
  ```

- **`customDomain` queries + mutations require `projectId`** — not just the customDomain ID. Queries like `{ customDomain(id: "…") { ... } }` fail with `argument "projectId" of type "String!" is required`. Pass both:
  ```graphql
  { customDomain(projectId: "…", id: "…") { domain status { ... } } }
  ```
  The top-level `customDomains(projectId: …)` field doesn't exist — query by individual ID, or query a service/project and descend to its domains.

- **Branch pinning uses `serviceConnect`, not `serviceInstanceUpdate`** — the `branch` field is NOT on `ServiceInstanceUpdateInput` (which only takes `source: { repo }`). It IS on `ServiceConnectInput`. To pin a service to a non-default branch:
  ```graphql
  mutation { serviceConnect(id: "$SVC", input: { repo: "owner/name", branch: "feat/xyz" }) { id } }
  ```
  Use `serviceInstanceUpdate` only for `rootDirectory`, `dockerfilePath`, `healthcheckPath`, etc. — not branch.

- **Storage Buckets** — Railway's GraphQL `bucketCreate` mutation creates a database record but does NOT provision the actual S3 instance. You MUST create buckets through the Railway dashboard UI. Once created there, you can query credentials via GraphQL: `bucketS3Credentials(bucketId, environmentId, projectId)`.

- **Deploying services** — use `serviceInstanceDeployV2` with a `commitSha` to trigger builds. The plain `serviceInstanceDeploy` often fails silently. Always pass the commit SHA:
  ```graphql
  mutation { serviceInstanceDeployV2(serviceId: "...", environmentId: "...", commitSha: "abc123") }
  ```

- **S3 bucket is private** — Railway buckets don't support public access. Images are served through the api-service as a proxy (`GET /images/:filename` → S3 GetObject → pipe to response). Image URLs in Nostr profiles point to the api-service, not directly to S3.

- **Build-phase logs are `buildLogs`, runtime logs are `deploymentLogs`** — if a deploy fails at build time, `deploymentLogs(deploymentId)` returns an empty array because the container never started. Use `buildLogs(deploymentId, limit)` for Dockerfile errors. If you call the wrong one, you'll see no output and think logs are broken.

- **Private networking is IPv6-only** — `*.railway.internal` DNS returns AAAA records only. A service binding on `0.0.0.0` (IPv4) is unreachable internally even though its public ingress (via Railway's Fastly proxy) keeps working. Every service that accepts internal traffic MUST bind `::` (dual-stack) or `[::]`. This manifests as intra-project traffic silently hanging/failing while each individual service reports healthy on its public domain.
  - Node.js: `server.listen(PORT, "::")` — explicit, not the default.
  - strfry/uWebSockets: `bind = "::"` in strfry.conf.
  - Any Go / Python / Rust service: use the dual-stack wildcard `[::]:PORT`.
  - Clients resolving the internal hostname need AAAA-capable DNS. Node ≥18 with `dns.lookup` default works; be wary of libraries that force `family: 4`.

- **Submodules aren't recursively cloned by Railway's GitHub integration** — if your repo has `.gitmodules`, those directories appear empty on the build host. Dockerfiles referencing `COPY submodule/…` silently succeed (empty glob) and then fail later (e.g. `npm ci` with no lockfile). Either vendor the submodule contents into the main repo, or `git clone` it inside the Dockerfile:
  ```dockerfile
  RUN apk add --no-cache git \
   && git clone --depth=1 https://github.com/foo/bar.git /app \
   && git -C /app checkout <pinned-sha>
  ```

- **Custom domain cert validation can stall for 20+ minutes** in `CERTIFICATE_STATUS_TYPE_VALIDATING_OWNERSHIP` even after DNS is fully propagated (their own API reports `DNS_RECORD_STATUS_PROPAGATED`). There is **no retry mutation** — `customDomainUpdate` only accepts `targetPort`. Options while waiting:
  1. Wait it out (Railway's LE flow does complete eventually).
  2. Delete + recreate the customDomain (blunt, but resets state).
  3. Ship on `*.up.railway.app` URLs and swap the Vercel env vars to custom once certs issue. Client DNS resolving through Cloudflare is fine — don't blame CF for this.

- **Railway service IDs** — stored in `.env` as `RELAY_SERVICE_ID`, `API_SERVICE_ID`, etc. The project ID is `RELAY_PROJECT_ID` and environment is `RELAY_ENV_ID`. This woid project uses a separate naming scheme (`WOID_RAILWAY_*`).

## Railway GraphQL Cheatsheet

```bash
# Auth header for all requests
RAILWAY_TOKEN=$(grep RAILWAY_TOKEN .env | cut -d= -f2)
AUTH="Authorization: Bearer $RAILWAY_TOKEN"

# Find your workspace (required for projectCreate)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ me { workspaces { id name } } }"}' \
  https://backboard.railway.app/graphql/v2

# Create a project
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { projectCreate(input: { name: \"NAME\", workspaceId: \"WS_ID\" }) { id environments { edges { node { id name } } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Create a service sourced from GitHub
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceCreate(input: { projectId: \"P\", name: \"svc\", source: { repo: \"owner/name\" } }) { id } }"}' \
  https://backboard.railway.app/graphql/v2

# Set rootDirectory + dockerfilePath (monorepo)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceInstanceUpdate(serviceId: \"S\", environmentId: \"E\", input: { rootDirectory: \"path/to/svc\", dockerfilePath: \"Dockerfile\", source: { repo: \"owner/name\" } }) }"}' \
  https://backboard.railway.app/graphql/v2

# Pin service to a branch (must use serviceConnect, NOT serviceInstanceUpdate)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceConnect(id: \"S\", input: { repo: \"owner/name\", branch: \"feat/xyz\" }) { id } }"}' \
  https://backboard.railway.app/graphql/v2

# List services
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ project(id: \"PROJECT_ID\") { services { edges { node { id name } } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Deploy with commit SHA
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceInstanceDeployV2(serviceId: \"...\", environmentId: \"...\", commitSha: \"...\") }"}' \
  https://backboard.railway.app/graphql/v2

# Set runtime env vars (also the mechanism for Dockerfile build ARGs)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableCollectionUpsert(input: { projectId: \"...\", environmentId: \"...\", serviceId: \"...\", variables: { KEY: \"value\" } }) }"}' \
  https://backboard.railway.app/graphql/v2

# Create a Railway-provided public domain
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceDomainCreate(input: { serviceId: \"S\", environmentId: \"E\", targetPort: 80 }) { domain } }"}' \
  https://backboard.railway.app/graphql/v2

# Create a custom domain (returns required CNAME target)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { customDomainCreate(input: { projectId: \"P\", serviceId: \"S\", environmentId: \"E\", domain: \"x.example.com\", targetPort: 80 }) { id domain status { dnsRecords { requiredValue } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Custom domain status (mind the projectId!)
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ customDomain(projectId: \"P\", id: \"D\") { domain status { verified certificateStatus certificateErrorMessage dnsRecords { status currentValue requiredValue } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Build logs (Dockerfile-phase) for a failing deploy
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ buildLogs(deploymentId: \"D\", limit: 100) { message severity } }"}' \
  https://backboard.railway.app/graphql/v2

# Runtime logs
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ deploymentLogs(deploymentId: \"D\", limit: 100) { message severity } }"}' \
  https://backboard.railway.app/graphql/v2

# Attach a persistent volume
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { volumeCreate(input: { projectId: \"P\", environmentId: \"E\", serviceId: \"S\", mountPath: \"/data\" }) { id name } }"}' \
  https://backboard.railway.app/graphql/v2

# Get bucket S3 credentials
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ bucketS3Credentials(bucketId: \"...\", environmentId: \"...\", projectId: \"...\") { accessKeyId secretAccessKey endpoint bucketName region } }"}' \
  https://backboard.railway.app/graphql/v2

# Deploy status
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ deployment(id: \"D\") { id status } }"}' \
  https://backboard.railway.app/graphql/v2
```
