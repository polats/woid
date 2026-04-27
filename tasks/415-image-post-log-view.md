---
name: World — Image-post log view
description: Dedicated browser view that lists every image post characters have made, mirroring the Persona API log shape — paginated grid of thumbnails with detail panel, sidebar status pill, click-through to Jumble.
status: done
order: 415
epic: world
depends_on: [355, 385]
related: [275, 305]
---

The Recap card now surfaces image posts as inline thumbnails (#385). That's enough to spot a recent post but useless for browsing the back-catalog or auditing the image pipeline. The Persona API view (`src/views/Personas.jsx`) is the right shape for that — paginated list, side detail, sidebar status pill.

This task ports that pattern to image posts.

## Slices

### Slice 1 — Bridge endpoint

- `GET /image-posts?limit=50&cursor=0` returns:
  ```json
  {
    "items": [
      {
        "event_id": "<hex>",
        "actor_pubkey": "<hex>",
        "actor_name": "Maya Tang",
        "text": "the watch keeps better time than i do.",
        "image_url": "https://.../posts/<id>.jpg",
        "image_prompt": "a silver pocket watch on a wooden counter, …",
        "sim_iso": "Day 3 · 14:21",
        "sim_day": 3,
        "ts": 1777300839001
      }
    ],
    "total": 47,
    "nextCursor": 50
  }
  ```
- Source: walk closed sessions + the open session; filter events `kind === "post" && image_url`. Sort newest-first. Cursor = offset.
- `GET /image-posts/status` returns `{ count, latest_ts, by_character: { "<pubkey>": <count> } }` for the sidebar pill.

### Slice 2 — Frontend view

- `src/views/ImagePosts.jsx` — list/detail same as Personas. Grid of 80×80 thumbnails with actor + text under each tile; clicking a row opens a side panel showing the full image + prompt + metadata + a Jumble link (`eventUrl(JUMBLE_URL, event_id, { author, kind: 1 })`).
- Empty state: "no image posts yet — wait for a `something-to-share` card to fire."
- Polls `/image-posts/status` every 30s for the sidebar count.

### Slice 3 — App wiring

- `App.jsx`: `'image-posts'` route → `<ImagePosts />` (gated by `agentSandbox` feature flag).
- `Sidebar.jsx`: new "Image Posts" section with a small status pill (count + latest sim_iso) under it. Sit it next to Persona API in the World column.

## Acceptance

- After at least one image post lands in a session, navigating to `#/image-posts` shows that post as a tile with actor name + text + sim_iso.
- Clicking the tile opens a detail panel showing the full image, the original `image_prompt`, the kind:1 `event_id`, and a "Open on Jumble" button that links to the nevent URL.
- The sidebar shows a count pill that updates within 30s of a new post.
- Pagination works for ≥ 50 posts.

## Non-goals

- Filtering / search by character or text.
- Editing or deleting posts.
- Image moderation queue.
