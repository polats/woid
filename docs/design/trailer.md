# Trailer — The Agency

Working doc for the launch trailer. Tracks title, taglines, strategy, references, and the beat sheet.

References:
- [vertical-slice.md](./vertical-slice.md) — audience and tonal calibration (the trailer deliberately violates the cozy-only frame; see Strategy below)
- [shelter-game.md](./shelter-game.md) — Severance shift mechanic, Castles-style tier progression, story-director-driven mystery
- [storyteller.md](./storyteller.md) — recap voice, cards, intensity scalar
- Article: [How to make a great game trailer](https://gamedevthings.com/article/How-to-make-a-great-game-trailer_86m1sdcbw7) — load-bearing for structure decisions below

---

## 1. Title

**The Agency** — a workplace-sim about managing LLM-driven characters ("agents") inside a vaguely-Severance-coded facility.

Double meaning:
- LLM agents (the AI-literate crowd catches it)
- Corporate agency (the general audience reads it as Lumon/CIA-coded mystery)

Discoverability is the weak spot — "The Agency" is generic. Mitigation: pair with a Steam subtitle that does the search work.

Subtitle candidates (pick one for Steam title field; capsule art shows only "The Agency"):
- **The Agency: A Shelter Sim**
- **The Agency: Bond with your agents**
- **The Agency: Break out of the loop**

Working subtitle: **The Agency: Bond with your agents.**

## 2. Taglines

Three approved candidates. Use two in the trailer; reserve the third for the Steam capsule.

1. **Every story is different.** — the LLM/emergence pitch; literally true because of the agent layer
2. **Bond with your agents.** — the parasocial sell; "agent" carries the AI pun without naming it
3. **Break out of the loop.** — diegetic (shift loop, recap loop) and meta (LLM escape); the trailer's structural payoff

Trailer uses **#2 in the warm middle** and **#3 as the closing line under the title card**. #1 lives on the Steam page.

## 3. Strategy — deliberate bait-and-switch

The `vertical-slice.md` audience is the cozy-sim cohort (Tomodachi/AC/Stardew). The trailer markets to a partially-different audience: the **Inscryption / DDLC / Severance cohort** — players who want a cozy surface with an unsettling reveal.

This is intentional. The trailer is its own art object. Watchers who bite are the ones who want *that specific tonal contract*: warmth on the surface, mystery underneath, an almost-jump-scare payoff. The shipped game still honors the 70/25/5 warmth split — the menace is texture, not gameplay.

Risk: the cozy-sim audience may refund if they expect pure warmth. Counter: the Steam page and screenshots lean cozy; the trailer is the hook for the second audience. Two doors into the same game.

AI angle: **leaned into.** Marketing names the agents as AI. The pun in the title carries the load.

## 4. Reference trailers

Top five to study (in priority order):

1. **Severance S2 teaser (Apple TV, 2024)** — literal aesthetic target; corporate-uncanny opening
2. **Get Out — original trailer (2017)** — the canonical cozy-to-nightmarish heel turn
3. **Her — trailer (Jonze, 2013)** — parasocial AI-bond sold via the human's face, not the AI's interface
4. **Russian Doll S1 trailer (Netflix)** — loop structure in 90s with charm intact
5. **John Lewis "The Bear and the Hare"** — parasocial warmth in 90s; ad-craft masterclass

Secondary references by beat:

| Beat | Reference |
|---|---|
| Corporate-uncanny opening | Severance S2 teaser, Apple "1984", Loki S1 trailer, Mad Men S1 promos |
| Cozy-to-nightmarish turn | Get Out, Hereditary teaser, Midsommar, Aphex Twin "Come to Daddy", Skinamarink |
| Loop structure | Russian Doll, Palm Springs, Triangle (2009), OK Go "Here It Goes Again" |
| Vignettes / "every story is different" | Beef trailer, This Is Us S1, Honda "Cog", Wildermyth launch, Dwarf Fortress Steam |
| Parasocial AI bond | Her, After Yang, Black Mirror "Be Right Back", M3GAN |
| Almost-jump-scare ending | Smile (2022), It Follows, Severance S1 ending shot |
| Cozy-game heel-turn (game refs) | Inscryption announcement, Buddy Simulator 1984 reveal, Doki Doki LC original |

Key craft lessons distilled:
- **Open on architecture, not a face** (Severance, 1984). Wide of the vertical grid before any character.
- **Music goes *wrong*, not *louder*** (Get Out, Midsommar). Hold a note too long; don't swap tracks.
- **Same shot three times with one element different** (Russian Doll). Sells a loop without captions.
- **Kicker text on a held still frame, not over action** (Beef). Only place to put recap prose on screen.
- **Held face for one second too long** (Severance, Smile). The cozy-safe version of a jump scare.

## 5. Beat sheet (v0)

Target length: **75 seconds**. Hard ceiling 90.

| # | Time | Duration | Shot | Source / capture | Audio | Caption |
|---|------|----------|------|------------------|-------|---------|
| 1 | 0:00 | 1.5s | Black, typewriter clack, title fades up: **The Agency** | Compositing | Typewriter only | "The Agency" |
| 2 | 0:01.5 | 2s | Wide of facility vertical grid, dim morning palette, no characters | `ShelterStage3D.jsx` — debug overlays off, camera held | Soft synth pad enters | — |
| 3 | 0:03.5 | 3s | A character (Mara) walks in through entrance, crosses to her room | `ShelterStage3D.jsx` — staged shift-arrival capture | Synth continues | — |
| 4 | 0:06.5 | 2s | Tap-to-focus on Mara: cel outline pulses, she faces camera, waves | `ShelterStage3D.jsx` tap handler | Synth | — |
| 5 | 0:08.5 | 3s | Held still on Mara, kicker line fades in below | composite over still frame | Synth | "Bond with your agents." |
| 6 | 0:11.5 | 4s | Rapid vignette cuts (1s each): build-mode room placement → palette eyedropper → Approve/Decline card tap → schedule-tab flick | `Shelter.jsx`, `ShelterRoomDetail.jsx`, `RequestQueue.jsx`, `ShelterCharacterCard.jsx` | Synth + light percussive tick | — |
| 7 | 0:15.5 | 3s | Recap card slides into the home-screen stack; hold on one killer recap line | `Recap.jsx` — record real session output | Synth swells slightly | (recap line itself, held, ~2s) |
| 8 | 0:18.5 | 6s | Three different characters, three different specific moments (bicker over weather; claim window seat; gift exchange) | Staged in `ShelterStage3D.jsx` | Synth peak — warmth high point | — |
| 9 | 0:24.5 | 2s | Tier indicator advances; new floor unlocks below visible ones | `Shelter.jsx` tier-up animation | Single held note begins | — |
| 10 | 0:26.5 | 3s | Build-mode shot, palette glitches for one frame; character glances at camera mid-animation when they shouldn't | Compositing + staged glance | Synth thins | "Every story is different." (reads ominous now) |
| 11 | 0:29.5 | 5s | LOOP: same shift-arrival walk, three different characters back-to-back, each shorter than the last | Recompose shot 3 with character swaps | Drone, no melody | — |
| 12 | 0:34.5 | 4s | A recap card we can't quite read; text scrolls or flickers | `Recap.jsx` with corrupted-text overlay | Drone | — |
| 13 | 0:38.5 | 3s | Hard cut to a Tier-N strange-floor room never seen before; one character standing still, facing camera, nameplate blank | New scene, staged | Drone drops out | — |
| 14 | 0:41.5 | 1.5s | Held face, one second too long. Single frame insert (a corrupted recap line / "INNIE" / a second face) | Compositing | Silence, then single tone | — |
| 15 | 0:43 | 2s | Black | — | Single tone fades | — |
| 16 | 0:45 | 3s | Title card: **THE AGENCY** in opening serif | Compositing | Typewriter clack | "Bond with your agents. Break out of the loop." |
| 17 | 0:48 | 2s | "Wishlist on Steam" — single CTA, no platforms list, no studio logo | Compositing | Silence | "Wishlist on Steam" |

**Total: ~50s.** Pad to 60–75s by extending the warm middle (shots 6–8) — the vignette stretch is where additional gameplay can land without breaking the structure.

Article-compliance audit:
- Hook in first 10s: ✓ (shots 1–4 establish facility + character + tap-to-focus)
- Genre signal via UI inside 10s: ✓ (shot 4 shows tap interaction; shot 6 shows build/cards/schedule)
- No studio logo at open: ✓
- One CTA at close: ✓
- Tone match (not epic): ✓ (synth pad → drone, no orchestral)
- Peak-end: ✓ (held face + title)
- Text minimal: 4 captions total, each ≤ 5 words, each held on near-still frame
- Cuts on action: ✓ (loop section cuts on character footfall)
- One recap-prose moment (shot 7) — the single article-flagged risk; mitigated by holding on still frame

## 6. Capture prep (engineering)

Before any shooting:
- **Trailer mode toggle** in `pi-bridge`: deterministic seed, debug overlays off, sim-clock slowed for human-paced beats, NPC pathing made deterministic per seed
- **Camera rig** in `ShelterStage3D.jsx`: scriptable camera moves (dolly, hold, push-in) addressable from a JSON shot list
- **Glitch shader** for shots 10, 12, 14: one-frame palette corruption + text-corruption pass
- **Recap text recorder**: capture real session output to a curated pool; pick the killer line for shot 7 from that pool
- **2K/60fps capture pipeline** — record raw, edit in post; no in-engine compression

## 7. Open questions

- **Which Tier-N room is shot 13?** Needs to be visually distinct from Tier-1 rooms. Probably needs to be designed for this trailer specifically.
- **The single-frame insert (shot 14):** corrupted recap line vs. literal face vs. the word "INNIE" — needs A/B testing on real viewers (r/DestroyMyGame style, not friends).
- **Music:** original composition vs. licensed track? Severance-style synth pad is achievable with a single commission. Budget TBD.
- **Capsule art** — separate from trailer but should match. Probably the wide vertical-grid shot from shot 2, with one tiny figure in one room.
- **Pacing of shot 11 (the loop):** how fast do the cuts compress? Needs editor judgment; defer to first cut.

## 8. Next actions

- [ ] Build trailer-mode toggle in bridge (capture prep)
- [ ] Design one Tier-N strange-floor room for shot 13
- [ ] Curate 20 recap lines from authored Day-1 sessions; pick top 5 for shot 7
- [ ] Watch top-five reference trailers; capture timecode notes
- [ ] First rough cut at 50s; iterate on r/DestroyMyGame before showing to friends
