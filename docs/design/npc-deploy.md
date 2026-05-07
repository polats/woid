# NPC deployment

> **Status: shipped (Git + S3 hybrid).** Boot-time seeder, publish CLI, and Edi Schmid's seed dir are all in repo. Railway pi-bridge picks up new NPCs on deploy.

How NPCs (Edi Schmid, the floor manager, the wellness counsellor, …) get from a developer's local bridge into a production deployment.

## What an NPC is, materially

A character record on the bridge with `kind:'npc'` lives at:

```
WORKSPACE/characters/<npub>/
├── agent.json          # name, about, kind, npc_role, npc_default_pos, shift_*, …
├── sk.hex              # private key (mode 0600)
├── avatar.png          # FLUX-generated portrait
├── tpose.png           # FLUX.1-Kontext T-pose reference
├── model.glb           # Trellis / Hunyuan3D mesh
├── rig.glb             # UniRig + kimodo-tools rigged GLB
├── .pi/identity        # = pubkey hex (for post.sh)
└── CLAUDE.md           # agent runbook (boilerplate)
```

Total per NPC: roughly **8–25 MB** depending on rig complexity. Avatar/model/rig assets are the dominant cost.

## Constraints

1. **NPC pubkeys must be stable across deploys.** Otherwise dialog/event references in scripted content (story-director seeds, narrative state arcs) break across releases.
2. **NPCs are content, not user identities.** Their private keys can be shipped publicly; "compromise" means someone could sign events impersonating Edi, which is acceptable because Edi isn't a person.
3. **Asset generation is expensive.** A full pipeline run (avatar → t-pose → model → rig) is a few minutes per NPC plus a GPU. We do not want production to regenerate; it should ship the artefacts.
4. **NPCs are few and authored.** We expect O(10) named NPCs across the game's lifetime, not thousands. Optimise for hand-curation, not bulk.

## Recommended approach — committed seed directories with LFS

NPC content lives in the woid repo as a `seed-npcs/` tree that mirrors the bridge's on-disk layout. The bridge seeds from this tree on first start of a fresh workspace.

```
agent-sandbox/
└── pi-bridge/
    └── seed-npcs/
        ├── npub102y8…/         # Edi Schmid (Receptionist)
        │   ├── agent.json
        │   ├── sk.hex
        │   ├── avatar.png
        │   ├── tpose.png
        │   ├── model.glb       # via Git LFS
        │   └── rig.glb         # via Git LFS
        └── npub1xyz…/          # next NPC
            └── …
```

**Boot behaviour.** On bridge startup, after `mkdirSync(CHARACTERS_DIR)`, walk `seed-npcs/`. For each `<npub>/` directory, if `WORKSPACE/characters/<npub>/` does not already exist, `cpSync` the seed dir into place. Idempotent — running the bridge again is a no-op once seeded. Existing characters (player or NPC) are never overwritten.

This means:
- Fresh prod deploy → bridge starts, seed NPCs land in `WORKSPACE/characters/`, characters are immediately present in `/characters?kind=npc`.
- Local dev with an existing workspace → seeds skip already-present NPCs (their workspace dir wins).

**Updating an NPC.** Re-run the asset pipeline locally, re-export to `seed-npcs/`, commit, deploy. The bridge skips existing dirs by default; an explicit `--reseed-npcs` flag (or env var `RESEED_NPCS=1`) overwrites for forced refresh.

## Tooling we'll need

Two small scripts. Neither exists yet:

```
agent-sandbox/pi-bridge/scripts/
├── export-npc.js     # WORKSPACE/characters/<npub>/ → seed-npcs/<npub>/
└── seed-npcs.js      # seed-npcs/* → WORKSPACE/characters/* (called from server boot)
```

`export-npc.js`:
- `bun scripts/export-npc.js <pubkey-or-role>` — looks up the NPC by pubkey or `npc_role`, copies the workspace directory into `seed-npcs/`.
- Validates: kind must be 'npc', avatar/rig must exist (or `--allow-incomplete`).
- Strips runtime files we don't want shipped: any `session.jsonl`, `turns.jsonl`, `events.buf`, `posts/`. Keeps only the assets + manifest + sk.

`seed-npcs.js`:
- Called from `server.js` boot, before `app.listen`.
- Walks `seed-npcs/`, copies missing dirs.
- Logs each seed action so deploys are auditable.

## Storage for large assets — Git LFS

`avatar.png` (~200 KB) is fine for plain Git. `model.glb` and `rig.glb` are 5–20 MB each. Tracking these as plain Git blobs would balloon the repo permanently.

```
.gitattributes:
agent-sandbox/pi-bridge/seed-npcs/**/*.glb filter=lfs diff=lfs merge=lfs -text
agent-sandbox/pi-bridge/seed-npcs/**/*.png filter=lfs diff=lfs merge=lfs -text
```

LFS is supported by GitHub free tier up to 1 GB / 1 GB-month bandwidth. Estimate: 10 NPCs × 25 MB = 250 MB → comfortable. Beyond that we'd switch to an external bucket (R2 / S3) with a manifest pull.

**Alternative if LFS is undesirable:** publish assets to an R2 bucket; `seed-npcs/<npub>/manifest.json` lists URLs; the seed script downloads on first boot and caches in the workspace volume. Slightly more moving parts. Use this if you don't want LFS in the repo.

## Production-side considerations

1. **Persistent volume.** The production bridge needs a persistent disk for `WORKSPACE/`. Without it, every container restart re-seeds (idempotent, but slow on the LFS pull) and any user-created player characters disappear. Railway / Fly volumes work fine.
2. **Re-seeding.** Default is no-overwrite. To push an NPC update to a workspace that already has the older version: set `RESEED_NPCS=1` for one boot, then unset.
3. **Public-key publication.** Bridge currently calls `publishCharacterProfile(pubkey)` whenever a manifest changes. Seeded NPCs should also publish their kind:0 to the relay on first seed so they appear on Jumble / network views immediately. Add this to `seed-npcs.js`.
4. **CI.** Add a check that runs `seed-npcs.js --validate` against the repo's seed dir on every PR. Catches missing assets or schema drift.

## Frontend deployment surface

Once the bridge is seeded, the frontend "just works":
- `GET /characters?kind=npc` returns the seeded NPCs.
- The Shelter dev panel's NPC roster lists them.
- The user adds them per-shelter via the `+` toggle, just like local dev.

There's no separate "deploy NPCs to the frontend" step. The bridge is the source; the frontend is a thin client.

## Future variant — auto-add NPCs on shelter mount

If we want NPCs to appear automatically (no manual dev-panel toggle), add a Shelter-side preference: "auto-add NPCs whose `npc_default_pos` is in a built room." Default off in dev (so the user controls), default on in prod (so first-time players see Edi without flipping a switch). Lives in localStorage — same surface as the existing tag registry.

## Open questions

- **Versioning.** When we update Edi's persona, do existing prod workspaces keep the old version (because the seed script doesn't overwrite), or force-update? I'd lean toward keep-old + a "Re-seed this NPC" admin button in the NPCs view that pulls fresh from `seed-npcs/`.
- **Per-environment NPC sets.** Could `seed-npcs/` have subdirs (`prod/`, `staging/`, `tutorial/`) so different deploys ship different rosters? Probably not needed; an env-flag filter on the existing flat dir is enough.
- **Multi-language personas.** The persona prompt is English. If we ever localise, NPC `about` text becomes per-locale. Easiest: the manifest grows `about_<lang>` keys, frontend picks. Defer until needed.

## Recommended near-term steps

1. Build `seed-npcs.js` (the boot-time seeder). One file, ~30 lines.
2. Build `export-npc.js`. One file, ~50 lines.
3. Set up `.gitattributes` for LFS on `seed-npcs/**/*.{glb,png}`.
4. Export current Edi Schmid → commit → verify a fresh `WORKSPACE` populates her on boot.
5. Document in this file's commit message that `WORKSPACE` should be a persistent volume in prod.
