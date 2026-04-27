import * as fs from 'node:fs'
import * as path from 'node:path'
import { test as base } from '@playwright/test'

/**
 * Per-test rich details payload captured at the end of a test for
 * the Testing view (src/Testing.jsx) to render.
 *
 * Tests build this incrementally via `step()` and call `flush()` once
 * at the end. We write `details.json` into Playwright's per-test
 * outputDir (where the .webm also lives) so the bundle script can
 * walk `test-results/<test-id>/` and pair each video with its
 * details. No fragile name matching.
 */

export type StepRecord = {
  label: string
  ok: boolean | undefined  // undefined = neutral / informational
  detail?: string
}

export type Artifacts = {
  character?: { name?: string; pubkey?: string; about?: string }
  characters?: Array<{ name?: string; pubkey?: string; about?: string }>
  nudge?: { slot?: string; target_room_id?: string; target_room_name?: string; target_x?: number; target_y?: number }
  movement?: { start?: { x: number; y: number; room_id?: string }; end?: { x: number; y: number; room_id?: string }; elapsed_ms?: number }
  scene?: { scene_id?: string; end_reason?: string; summary_source?: string }
  moodlets?: Array<{ pubkey?: string; tag: string; weight: number; reason?: string }>
  notes?: string
}

export type TestDetailsPayload = {
  title: string
  spec: string                 // "e2e/<file>.spec.ts:<line>"
  summary: string              // 1-3 sentence narrative
  steps: StepRecord[]
  artifacts?: Artifacts
}

export class TestDetails {
  private steps: StepRecord[] = []
  private artifacts: Artifacts = {}
  private summary = ''
  constructor(private title: string, private spec: string) {}

  step(label: string, ok: boolean | undefined = true, detail?: string) {
    this.steps.push({ label, ok, detail })
  }
  setSummary(s: string) { this.summary = s }
  setArtifact<K extends keyof Artifacts>(key: K, value: Artifacts[K]) {
    this.artifacts[key] = value
  }
  notes(s: string) { this.artifacts.notes = s }

  /**
   * Write details.json next to the .webm in Playwright's per-test
   * outputDir. The bundle script walks `test-results/` and pairs
   * each video with its details file by directory.
   */
  flush() {
    const info = base.info()
    const outDir = info.outputDir
    if (!outDir) return
    fs.mkdirSync(outDir, { recursive: true })
    const payload: TestDetailsPayload = {
      title: this.title,
      spec: this.spec,
      summary: this.summary,
      steps: this.steps,
      artifacts: this.artifacts,
    }
    fs.writeFileSync(path.join(outDir, 'details.json'), JSON.stringify(payload, null, 2))
  }
}
