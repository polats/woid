#!/usr/bin/env bash
# Iterate scripts/kimodo-anim-prompts.json and POST each prompt to
# the kimodo motion API serially (single-GPU, no parallel). Logs
# results to e2e-runs/kimodo-anim-results.json with category + id +
# prompt so the assignment UI can pick from them by category.
set -euo pipefail

PROMPTS=/home/paul/projects/woid/scripts/kimodo-anim-prompts.json
OUT=/home/paul/projects/woid/e2e-runs/kimodo-anim-results.json
KIMODO=${KIMODO_URL:-http://localhost:7862}

mkdir -p "$(dirname "$OUT")"
echo '{"results": []}' > "$OUT"

count=0
total=$(python3 -c "import json; p=json.load(open('$PROMPTS')); print(len(p['work']) + len(p['reaction']))")

for category in work reaction; do
  while IFS= read -r prompt; do
    count=$((count + 1))
    start=$(date +%s)
    body=$(printf '{"prompt":%s,"seconds":5.0}' "$(printf %s "$prompt" | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))")")
    # /generate returns the full motion JSON; we only need the id.
    # Find it by polling /animations for the newest entry after the
    # call lands. Faster: kimodo's response body has the id at top
    # level in newer builds, but we don't depend on that.
    curl -s -X POST -H 'Content-Type: application/json' -d "$body" "$KIMODO/generate" -o /tmp/kimodo-gen.json
    id=$(curl -s "$KIMODO/animations" | python3 -c "
import json,sys
data=json.load(sys.stdin)
a=sorted(data['animations'], key=lambda x: x['created_at'], reverse=True)[0]
print(a['id'])
")
    dt=$(( $(date +%s) - start ))
    echo "[$count/$total] $category $id ${dt}s — $prompt"
    python3 -c "
import json
out=json.load(open('$OUT'))
out['results'].append({'category':'$category','id':'$id','seconds':5.0,'prompt':$(python3 -c "import json,sys;print(json.dumps(sys.stdin.read().rstrip()))" <<<"$prompt")})
json.dump(out, open('$OUT','w'), indent=2)
"
  done < <(python3 -c "import json; p=json.load(open('$PROMPTS')); [print(s) for s in p['$category']]")
done

echo done
