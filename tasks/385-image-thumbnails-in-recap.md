---
name: World — Image-post thumbnails in Recap UI
description: When a session event is a `post` with image_url, render the image as a small thumbnail beneath the recap card so image storytelling actually surfaces in the home screen.
status: done
order: 385
epic: world
depends_on: [355, 275]
---

Maya can post photographs (#355 shipped). The session captures `image_url` on each `post` event. The Recap UI sees nothing — the image stays buried in the journal until someone curls `/sessions/:simDay`.

Easy win: render thumbnails inline.

## Slices

### Slice 1 — Render thumbnails in Recap card

In `src/Recap.jsx`, when a session has events with `image_url`:

```jsx
<div className="recap-images">
  {imagePosts.map((p) => (
    <a href={p.image_url} target="_blank" rel="noreferrer" key={p.image_url}>
      <img src={p.image_url} alt="" />
    </a>
  ))}
</div>
```

Tile thumbnails (max 3 visible, "+N" overflow if more), 80×80 each, anchored at the bottom of the recap card. Click opens full-size in a new tab.

### Slice 2 — Style + lazy-load

`.recap-images` flex row, paper-and-ink border, `loading="lazy"` on each image so cards don't fire 5+ FLUX images on initial render.

### Slice 3 — Past recap stack

Same render path inside the collapsed past-recap detail view.

## Acceptance

- A session that has at least one `post` event with an `image_url` shows the image as a thumbnail in its recap card.
- Clicking the thumbnail opens the full-size image in a new tab.
- Sessions with no image posts render exactly as today.
- Lazy-load means scrolling through 30 past recaps doesn't fetch 30 images upfront.

## Non-goals

- Lightbox / inline gallery (defer; new-tab is fine).
- Image attribution / re-share.
