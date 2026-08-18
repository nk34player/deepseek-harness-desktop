import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const hasCert = "${{ secrets.MAC_CERT_P12 != '' && secrets.MAC_CERT_PASSWORD != '' }}"

describe('Desktop release workflow', () => {
  it('builds the macOS installer unsigned when the certificate secrets are absent', () => {
    const workflow = loadWorkflow('.github/workflows/desktop-release.yml')
    const job = workflowJob(workflow, 'build-macos')
    // GitHub Actions forbids the `secrets` context inside `if:` conditions, so
    // the certificate-presence boolean is computed once as a job env var and
    // the steps branch on it.
    expect(job.env).toMatchObject({ HAS_MAC_CERT: hasCert })
    const steps = job.steps
    if (!Array.isArray(steps)) throw new TypeError('macOS job must define steps')
    const macosSteps = steps.filter(isRecord)
    const stepByName = (name: string) => macosSteps.find(step => step.name === name)

    // The cert-import step must be skipped when either certificate secret is
    // missing, instead of hard-failing on an empty .p12.
    expect(stepByName('Import signing certificate')?.if).toBe("env.HAS_MAC_CERT == 'true'")

    // Signing only runs when both certificate secrets are present; the
    // complementary step falls back to the unsigned packaging script so a
    // release still produces a dmg without the certificate.
    expect(stepByName('Package macOS')).toMatchObject({
      if: "env.HAS_MAC_CERT == 'true'",
      run: 'pnpm --filter @deepseek-ai/dsh-desktop run dist:mac',
    })
    expect(stepByName('Package macOS (unsigned)')).toMatchObject({
      if: "env.HAS_MAC_CERT == 'false'",
      run: 'pnpm --filter @deepseek-ai/dsh-desktop run dist:mac:unsigned',
    })
  })

  it('ships the unsigned packaging script the release workflow falls back to', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const script = manifest.scripts['dist:mac:unsigned']
    expect(script).toContain('--mac')
    expect(script).toContain('--config.mac.identity=null')
    expect(script).toContain('--config.mac.notarize=false')
  })
})

function loadWorkflow(path: string): Record<string, unknown> {
  const workflow: unknown = yaml.load(readFileSync(resolve(root, path), 'utf8'))
  if (!isRecord(workflow)) throw new TypeError(`${path} must define a workflow`)
  return workflow
}

function workflowJob(workflow: Record<string, unknown>, job: string): Record<string, unknown> {
  if (!isRecord(workflow.jobs) || !isRecord(workflow.jobs[job])) {
    throw new TypeError(`workflow must define the ${job} job`)
  }
  return workflow.jobs[job]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
