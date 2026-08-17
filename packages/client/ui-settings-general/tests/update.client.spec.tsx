// @vitest-environment jsdom
/** Desktop bridge detection and update-row smoke. */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import {
  UpdateRow,
  readDesktopUpdatesBridge,
} from '../src/client/UpdateRow.tsx'
import type { UpdatesBridge } from '../src/client/dsh-desktop-bridge.ts'

const unusedHook = (() => { throw new Error('unused by update row') }) as never
const kit = { useSessions: unusedHook, useWorkspaces: unusedHook }

function bridge(overrides: Partial<UpdatesBridge> = {}): UpdatesBridge {
  return {
    getStatus: vi.fn(async () => ({ phase: 'idle' } as const)),
    getVersion: vi.fn(async () => '0.1.0-rc.10'),
    onStatus: vi.fn(() => () => {}),
    check: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('readDesktopUpdatesBridge', () => {
  afterEach(() => {
    delete window.dshDesktop
  })

  it('returns undefined when the preload bridge is absent', () => {
    expect(readDesktopUpdatesBridge()).toBeUndefined()
  })

  it('returns the bridge when the updates surface exists', () => {
    const updates = bridge()
    window.dshDesktop = { updates }
    expect(readDesktopUpdatesBridge()).toBe(updates)
  })

  it('returns undefined when the updates surface is incomplete', () => {
    window.dshDesktop = { updates: { getStatus: vi.fn() } as unknown as UpdatesBridge }
    expect(readDesktopUpdatesBridge()).toBeUndefined()
  })
})

describe('UpdateRow', () => {
  beforeEach(() => {
    window.dshDesktop = { updates: bridge() }
  })

  afterEach(() => {
    cleanup()
    delete window.dshDesktop
  })

  it('renders the version and a Check for updates action when idle', async () => {
    const t = (key: string) => ({
      'update.title': '版本',
      'update.reading': '正在读取版本…',
      'update.check': '检查更新',
      'update.noop': '—',
      'update.idle': '—',
    }[key] ?? key)

    render(<UpdateRow {...kit} t={t as never} />)
    expect(await screen.findByText('版本')).toBeTruthy()
    expect(await screen.findByText('0.1.0-rc.10')).toBeTruthy()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeTruthy()
  })

  it('offers Restart & Update once a version is downloaded', async () => {
    window.dshDesktop = {
      updates: bridge({
        getStatus: vi.fn(async () => ({ phase: 'downloaded' as const, version: '0.1.0-rc.11' })),
      }),
    }
    const t = (key: string) => ({
      'update.title': '版本',
      'update.ready': '已就绪，可安装：',
      'update.install': '重启并更新',
      'update.noop': '—',
    }[key] ?? key)

    render(<UpdateRow {...kit} t={t as never} />)
    expect(await screen.findByText('已就绪，可安装： v0.1.0-rc.11')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重启并更新' })).toBeTruthy()
  })
})
