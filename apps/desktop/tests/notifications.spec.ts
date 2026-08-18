import { describe, expect, it } from 'vitest'
import {
  createNotificationThrottle,
  parseRendererNotification,
  restartNotificationFor,
} from '../src/notifications.ts'

describe('desktop restart notifications', () => {
  it('announces the first restart attempt', () => {
    expect(restartNotificationFor(1)?.key).toBe('restart')
  })

  it('escalates on the third consecutive attempt', () => {
    expect(restartNotificationFor(3)?.key).toBe('repeated-restart')
  })

  it('stays quiet on the attempts in between and after', () => {
    expect(restartNotificationFor(2)).toBeUndefined()
    expect(restartNotificationFor(4)).toBeUndefined()
    expect(restartNotificationFor(5)).toBeUndefined()
  })
})

describe('desktop notification throttle', () => {
  it('allows the first occurrence of a key', () => {
    const throttle = createNotificationThrottle(60_000)
    expect(throttle.allow('restart', 1_000)).toBe(true)
  })

  it('suppresses a repeated key inside the window', () => {
    const throttle = createNotificationThrottle(60_000)
    throttle.allow('restart', 1_000)
    expect(throttle.allow('restart', 2_000)).toBe(false)
  })

  it('allows a repeated key once the window has elapsed', () => {
    const throttle = createNotificationThrottle(60_000)
    throttle.allow('restart', 1_000)
    expect(throttle.allow('restart', 61_000)).toBe(true)
  })

  it('tracks keys independently', () => {
    const throttle = createNotificationThrottle(60_000)
    throttle.allow('restart', 1_000)
    expect(throttle.allow('recovered', 2_000)).toBe(true)
  })
})

describe('renderer notification parsing (IPC trust boundary)', () => {
  it('accepts a { title, body } payload', () => {
    expect(parseRendererNotification({ title: 'Title', body: 'Body' }))
      .toEqual({ title: 'Title', body: 'Body' })
  })

  it('rejects non-object payloads', () => {
    expect(parseRendererNotification(undefined)).toBeUndefined()
    expect(parseRendererNotification(null)).toBeUndefined()
    expect(parseRendererNotification('x')).toBeUndefined()
    expect(parseRendererNotification(42)).toBeUndefined()
  })

  it('rejects missing or empty title/body', () => {
    expect(parseRendererNotification({})).toBeUndefined()
    expect(parseRendererNotification({ title: 'Title' })).toBeUndefined()
    expect(parseRendererNotification({ body: 'Body' })).toBeUndefined()
    expect(parseRendererNotification({ title: '', body: 'Body' })).toBeUndefined()
    expect(parseRendererNotification({ title: 'Title', body: '' })).toBeUndefined()
    expect(parseRendererNotification({ title: 1, body: 'Body' })).toBeUndefined()
  })
})
