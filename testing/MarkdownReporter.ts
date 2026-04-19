import type { Reporter, FullResult, TestCase, TestResult } from '@playwright/test/reporter'
import * as fs from 'fs'
import * as path from 'path'

// After each Playwright run, copy .webm videos into a timestamped session
// dir and update testing/sessions/manifest.json so viewer.html can list it.

interface TestRecord {
  title: string
  ok: boolean
  duration: number
  error?: string
  videoFilename?: string
}

class MarkdownReporter implements Reporter {
  private results: TestRecord[] = []
  private sessionDir: string
  private sessionName: string
  private startTime: number = Date.now()

  constructor() {
    const now = new Date()
    this.sessionName = `${now.toISOString().slice(0, 10)}-${now.toTimeString().slice(0, 5).replace(':', '')}`
    this.sessionDir = path.join(process.cwd(), 'testing', 'sessions', this.sessionName)
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true })
    }
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const videoAttachment = result.attachments.find((a) => a.name === 'video')
    const filename = `${test.title.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.webm`
    let videoFilename: string | undefined

    if (videoAttachment?.path) {
      const destPath = path.join(this.sessionDir, filename)
      try {
        fs.copyFileSync(videoAttachment.path, destPath)
        videoFilename = filename
      } catch (e) {
        console.error('Failed to copy video', e)
      }
    }

    this.results.push({
      title: test.title,
      ok: result.status === 'passed',
      duration: result.duration,
      error: result.error?.message,
      videoFilename,
    })
  }

  async onEnd(result: FullResult) {
    const isPass = result.status === 'passed'
    const totalDuration = Date.now() - this.startTime

    let md = `# ${this.sessionName}\n**Result:** ${isPass ? 'PASS ✅' : 'FAIL ❌'}\n**Duration:** ${(totalDuration / 1000).toFixed(1)}s\n\n`
    md += `| Step | Recording | Result | Time |\n|---|---|---|---|\n`
    for (const r of this.results) {
      md += `| ${r.title} | ${r.videoFilename ?? 'No Video'} | ${r.ok ? '✅' : '❌'} | ${(r.duration / 1000).toFixed(1)}s |\n`
    }
    if (this.results.some((r) => !r.ok)) {
      md += `\n## Errors\n\n`
      for (const r of this.results.filter((r) => !r.ok && r.error)) {
        md += `### ${r.title}\n\`\`\`\n${r.error!.trim()}\n\`\`\`\n\n`
      }
    }
    fs.writeFileSync(path.join(this.sessionDir, 'session.md'), md)

    const sessionData = {
      name: this.sessionName,
      date: new Date().toISOString(),
      pass: isPass,
      duration: totalDuration,
      tests: this.results,
    }
    fs.writeFileSync(path.join(this.sessionDir, 'session.json'), JSON.stringify(sessionData, null, 2))

    const manifestPath = path.join(process.cwd(), 'testing', 'sessions', 'manifest.json')
    let manifest: any[] = []
    try {
      if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      }
    } catch {}

    const idx = manifest.findIndex((s: any) => s.name === this.sessionName)
    const entry = {
      name: this.sessionName,
      date: new Date().toISOString(),
      pass: isPass,
      duration: totalDuration,
      testCount: this.results.length,
      passCount: this.results.filter((r) => r.ok).length,
    }
    if (idx >= 0) manifest[idx] = entry
    else manifest.unshift(entry)
    manifest = manifest.slice(0, 50)
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))

    console.log(`\n📋 Session: ${this.sessionDir}`)
    console.log(`${isPass ? '✅ PASS' : '❌ FAIL'} — ${this.results.length} tests, ${(totalDuration / 1000).toFixed(1)}s`)
    console.log(`🎬 Videos: ${this.results.filter((r) => r.videoFilename).length} recorded`)
    console.log(`📺 View: npx serve testing -l 3333 → http://localhost:3333/viewer.html\n`)
  }
}

export default MarkdownReporter
