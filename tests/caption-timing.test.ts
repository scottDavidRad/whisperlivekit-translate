import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptionTiming } from '../src/caption-timing.ts'
afterEach(() => mock.timers.reset())
test('clears after the last changed caption, despite repeated server snapshots', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let clears = 0
  const captions = new CaptionTiming(5, () => clears++)
  captions.update('Hello')
  mock.timers.tick(4000)
  captions.update('Hello')
  mock.timers.tick(1000)
  assert.equal(clears, 1)
  assert.equal(captions.hidden, true)
  captions.update('Hello again')
  assert.equal(captions.hidden, false)
  captions.dispose()
})
test('stay-until-replaced disables expiry; explicit pause still clears', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  let clears = 0
  const captions = new CaptionTiming(0, () => clears++)
  captions.update('Keep reading')
  mock.timers.tick(60_000)
  assert.equal(clears, 0)
  captions.clear()
  assert.equal(clears, 1)
  captions.reset()
  assert.equal(captions.hidden, false)
})
