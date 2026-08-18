/**
 * Update-status source: seeds from the bridge, follows pushes, and raises a
 * native notification once when a new version first becomes available (only
 * under the desktop shell; a plain browser is a silent no-op).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUpdateStatusSource } from '../src/client/status-source.ts'
import type { DesktopUpdateBridge, UpdateStatus } from '../src/client/desktop-bridge.ts'

function makeBridge(): DesktopUpdateBridge {
  return {
    getStatus: vi.fn(() => Promise.resolve({ phase: 'idle' } as UpdateStatus)),
    onStatus: vi.fn(() => () => {}),
    check: vi.fn(),
    install: vi.fn(),
  }
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).window
})

/** The status-push callback the source subscribes with. */
function pushOf(bridge: DesktopUpdateBridge): (status: UpdateStatus) => void {
  return vi.mocked(bridge.onStatus).mock.calls[0]![0]
}

describe('update status source notifications', () => {
  it('notifies once when a new version becomes available', () => {
    const notify = vi.fn()
    ;(globalThis as Record<string, unknown>).window = { dshDesktop: { notify } }
    const bridge = makeBridge()
    const source = createUpdateStatusSource(bridge)
    source.start()
    const push = pushOf(bridge)

    push({ phase: 'available', version: '0.2.0' })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledWith({ title: 'DeepSeek Harness', body: 'Update 0.2.0 available' })

    // A same-version re-push (interval re-check) must not re-alert the user.
    push({ phase: 'available', version: '0.2.0' })
    expect(notify).toHaveBeenCalledTimes(1)
    source.dispose()
  })

  it('does not notify on non-available statuses', () => {
    const notify = vi.fn()
    ;(globalThis as Record<string, unknown>).window = { dshDesktop: { notify } }
    const bridge = makeBridge()
    const source = createUpdateStatusSource(bridge)
    source.start()
    const push = pushOf(bridge)

    push({ phase: 'checking' })
    push({ phase: 'downloading', version: '0.2.0', percent: 50 })
    push({ phase: 'up-to-date' })
    expect(notify).not.toHaveBeenCalled()
    source.dispose()
  })
})
