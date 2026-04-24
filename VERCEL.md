## Gotchas

### Vercel

- **`productionBranch` cannot be changed via PATCH.** Attempts like `PATCH /v10/projects/{id}` with `{"gitRepository":{"productionBranch":"…"}}` or top-level `{"productionBranch":"…"}` return `Invalid request: should NOT have additional property …`. The project's production branch is set at creation from the repo's default branch and can only be changed in the dashboard (Settings → Git). To deploy a non-default branch to production without changing it, trigger directly via the deployments API with `target: "production"`:
  ```bash
  curl -H "Authorization: Bearer $VERCEL_TOKEN" -H "Content-Type: application/json" \
    -X POST "https://api.vercel.com/v13/deployments?teamId=$TEAM&forceNew=1" \
    -d '{
      "name":"projname",
      "project":"prj_…",
      "target":"production",
      "gitSource":{
        "type":"github",
        "repoId": 123456789,
        "ref":"feat/branch-name",
        "sha":"<commit sha>"
      }
    }'
  ```

- **`gitSource.repoId` is required, not `repo`.** The shape `{"type":"github","repo":"owner/name","ref":"…"}` fails with `missing required property repoId`. Get the numeric ID from the GitHub API:
  ```bash
  curl -s https://api.github.com/repos/OWNER/NAME | jq .id
  ```

- **Project creation auto-assigns the apex domain if already validated.** When `POST /v10/projects` is called on a team whose apex (`noods.cc`) is already verified for another project, attaching `woid.noods.cc` via `POST /domains` returns `"verified": true` instantly — no DNS TXT dance needed.

- **Env var `target` field is required on upsert.** Include `"target":["production","preview"]` (or the subset you want) — without it the env var is created but not attached to any environment and your build won't see it.

- **Env IDs are needed to PATCH, not the key.** To update a value:
  ```bash
  curl -s -H "$AUTH" https://api.vercel.com/v10/projects/PROJ/env?teamId=TEAM  # list, find id
  curl -s -H "$AUTH" -X PATCH https://api.vercel.com/v10/projects/PROJ/env/ENV_ID?teamId=TEAM \
    -d '{"value":"new-value","target":["production","preview"]}'
  ```
  A POST to `/env` with the same key creates a duplicate unless you add `&upsert=true`.

## Vercel API Cheatsheet

```bash
VT=$(grep VERCEL_TOKEN .env | cut -d= -f2)
TEAM=$(grep WOID_VERCEL_TEAM_ID .env | cut -d= -f2)
PROJ=$(grep WOID_VERCEL_PROJECT_ID .env | cut -d= -f2)
AUTH="Authorization: Bearer $VT"

# Who am I (confirms token)
curl -s -H "$AUTH" "https://api.vercel.com/v2/user"

# Create a project linked to GitHub
curl -s -H "$AUTH" -H "Content-Type: application/json" -X POST \
  "https://api.vercel.com/v10/projects?teamId=$TEAM" \
  -d '{"name":"woid","framework":"vite","buildCommand":"vite build","outputDirectory":"dist","gitRepository":{"type":"github","repo":"owner/name"}}'

# Upsert an env var
curl -s -H "$AUTH" -H "Content-Type: application/json" -X POST \
  "https://api.vercel.com/v10/projects/$PROJ/env?teamId=$TEAM&upsert=true" \
  -d '{"key":"KEY","value":"val","type":"plain","target":["production","preview"]}'

# Attach a custom domain
curl -s -H "$AUTH" -H "Content-Type: application/json" -X POST \
  "https://api.vercel.com/v10/projects/$PROJ/domains?teamId=$TEAM" \
  -d '{"name":"sub.example.com"}'

# Force a production deploy on a specific branch/sha
curl -s -H "$AUTH" -H "Content-Type: application/json" -X POST \
  "https://api.vercel.com/v13/deployments?teamId=$TEAM&forceNew=1" \
  -d '{"name":"woid","project":"'$PROJ'","target":"production","gitSource":{"type":"github","repoId":123,"ref":"branch","sha":"sha"}}'

# Poll a deployment
curl -s -H "$AUTH" "https://api.vercel.com/v13/deployments/$DEPLOY_ID?teamId=$TEAM" | jq '{readyState,url,alias}'
```
