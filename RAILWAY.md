## Gotchas

### Railway

- **Railway CLI token** — the `RAILWAY_TOKEN` in `.env` works with the GraphQL API (`https://backboard.railway.app/graphql/v2`) but NOT with the Railway CLI. The CLI needs a different auth flow (`railway login`). Always use GraphQL for automation.

- **Storage Buckets** — Railway's GraphQL `bucketCreate` mutation creates a database record but does NOT provision the actual S3 instance. You MUST create buckets through the Railway dashboard UI. Once created there, you can query credentials via GraphQL: `bucketS3Credentials(bucketId, environmentId, projectId)`.

- **Deploying api-service** — use `serviceInstanceDeployV2` with a `commitSha` to trigger builds. The plain `serviceInstanceDeploy` often fails silently. Always pass the commit SHA:
  ```graphql
  mutation { serviceInstanceDeployV2(serviceId: "...", environmentId: "...", commitSha: "abc123") }
  ```

- **S3 bucket is private** — Railway buckets don't support public access. Images are served through the api-service as a proxy (`GET /images/:filename` → S3 GetObject → pipe to response). Image URLs in Nostr profiles point to the api-service, not directly to S3.

- **Railway service IDs** — stored in `.env` as `RELAY_SERVICE_ID`, `API_SERVICE_ID`, etc. The project ID is `RELAY_PROJECT_ID` and environment is `RELAY_ENV_ID`.

## Railway GraphQL Cheatsheet

```bash
# Auth header for all requests
RAILWAY_TOKEN=$(grep RAILWAY_TOKEN .env | cut -d= -f2)
AUTH="Authorization: Bearer $RAILWAY_TOKEN"

# List services
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ project(id: \"PROJECT_ID\") { services { edges { node { id name } } } } }"}' \
  https://backboard.railway.app/graphql/v2

# Deploy with commit SHA
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { serviceInstanceDeployV2(serviceId: \"...\", environmentId: \"...\", commitSha: \"...\") }"}' \
  https://backboard.railway.app/graphql/v2

# Set env vars
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"mutation { variableCollectionUpsert(input: { projectId: \"...\", environmentId: \"...\", serviceId: \"...\", variables: { KEY: \"value\" } }) }"}' \
  https://backboard.railway.app/graphql/v2

# Get bucket S3 credentials
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ bucketS3Credentials(bucketId: \"...\", environmentId: \"...\", projectId: \"...\") { accessKeyId secretAccessKey endpoint bucketName region } }"}' \
  https://backboard.railway.app/graphql/v2

# Check deploy status
curl -s -H "$AUTH" -H "Content-Type: application/json" \
  -d '{"query":"{ deployments(input: { serviceId: \"...\", environmentId: \"...\" }, first: 1) { edges { node { id status } } } }"}' \
  https://backboard.railway.app/graphql/v2
```
