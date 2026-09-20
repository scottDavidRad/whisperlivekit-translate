import { afterEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { CaptionPager } from '../src/caption-pager.ts'

const active: CaptionPager[] = []
afterEach(() => { active.splice(0).forEach(pager => pager.dispose()); mock.timers.reset() })
function setup(rows = 2, width = 100) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 })
  const output: string[] = []
  const wrap = (text: string): string[] => {
    const lines: string[] = []
    for (const paragraph of text.split('\n')) {
      let line = ''
      for (const word of paragraph.split(' ')) {
        if (line && line.length + 1 + word.length > width) { lines.push(line); line = '' }
        line += (line ? ' ' : '') + word
      }
      if (line) lines.push(line)
    }
    return lines
  }
  const pager = new CaptionPager({ rows, wrap }, text => output.push(text))
  active.push(pager)
  return { pager, output, wrap }
}

test('first text is prompt; additions are throttled without moving completed rows', () => {
  const { pager, output } = setup(3, 10)
  pager.update('one two')
  assert.deepEqual(output, ['one two'])
  pager.update('one two three')
  mock.timers.tick(400)
  pager.update('one two three four')
  mock.timers.tick(299)
  assert.equal(output.length, 1)
  mock.timers.tick(1)
  assert.equal(output.at(-1), 'one two\nthree four')
  pager.update('one two three four')
  mock.timers.tick(10_000)
  assert.equal(output.length, 2)
})

test('overflow advances whole pages after dwell even when no more speech arrives', () => {
  const { pager, output } = setup()
  pager.update('one\ntwo\nthree\nfour\nfive')
  assert.deepEqual(output, ['one\ntwo'])
  mock.timers.tick(2499)
  assert.equal(output.length, 1)
  mock.timers.tick(1)
  assert.equal(output.at(-1), 'three\nfour')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'five')
  mock.timers.tick(10_000)
  assert.equal(output.length, 3)
})

test('repeated page text is a new page, but repeated snapshots are not', () => {
  const { pager, output } = setup(1)
  pager.update('same\nsame\nlast')
  pager.update('same\nsame\nlast')
  mock.timers.tick(2500)
  assert.deepEqual(output, ['same', 'same'])
  mock.timers.tick(2500)
  assert.deepEqual(output, ['same', 'same', 'last'])
})

test('packs short speaker turns and repeats the speaker on continued pages', () => {
  const { pager, output } = setup(2, 20)
  pager.update('Speaker 1: Hello.\nSpeaker 2: These words continue onto another page with more context.')
  assert.equal(output[0], 'Speaker 1: Hello.\nSpeaker 2: These')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'Speaker 2: words\ncontinue onto')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'Speaker 2: another\npage with more')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'Speaker 2: context.')
})

test('current-page corrections replace text, and past corrections do not replay read pages', () => {
  const { pager, output } = setup()
  pager.update('wrong\ntwo\nthree\nfour\nfive')
  pager.update('correct\ntwo\nthree\nfour\nfive')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'correct\ntwo')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'three\nfour')
  pager.update('a longer correction\ntwo\nthree\nfour\nfive')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'three\nfour')
  mock.timers.tick(1800)
  assert.equal(output.at(-1), 'five')
  assert.equal(output.filter(text => text.includes('three')).length, 1)
})

test('speaker revisions replace attribution without replaying or duplicating words', () => {
  const { pager, output } = setup(3)
  pager.update('Speaker 1: One.\nSpeaker 2: Two.')
  pager.update('Speaker 1: One. Two.')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'Speaker 1: One. Two.')
  mock.timers.tick(5000)
  assert.equal(output.length, 2)
})

test('wholesale wording changes after a page advance show the replacement from its beginning', () => {
  const { pager, output } = setup(2)
  pager.update('Speaker 1: old first\nold second\nold third\nold fourth')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'Speaker 1: old third\nold fourth')
  pager.update('Speaker 1: Completely different replacement.')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'Speaker 1: Completely different replacement.')
  pager.update('Speaker 1: Completely different replacement.')
  mock.timers.tick(10_000)
  assert.equal(output.length, 3)
})

test('a past correction plus appended speech preserves the uniquely surviving unread page', () => {
  const { pager, output } = setup(2)
  pager.update('one\ntwo\nthree\nfour')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'three\nfour')
  pager.update('ONE\ntwo\nthree\nfour\nfive')
  mock.timers.tick(700)
  assert.deepEqual(output, ['one\ntwo', 'three\nfour'])
  mock.timers.tick(1800)
  assert.equal(output.at(-1), 'five')
})

test('compound revisions do not anchor to ambiguous repeated or very short text', () => {
  const { pager, output } = setup(1)
  pager.update('old\nrepeated phrase\nrepeated phrase')
  mock.timers.tick(2500)
  mock.timers.tick(2500)
  pager.update('NEW\nrepeated phrase\nrepeated phrase\nadded')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'NEW')
  pager.reset()
  pager.update('old\nshort')
  mock.timers.tick(2500)
  pager.update('NEW\nshort\nadded')
  mock.timers.tick(700)
  assert.equal(output.at(-1), 'NEW')
})

test('intentional blank spacing consumes physical rows without replaying or getting stuck', () => {
  const { pager, output } = setup(3)
  pager.configure({ wrap: text => ['', ...text.split('\n').flatMap(line => [line, ''])] })
  pager.update('one\ntwo\nthree\nfour')
  assert.equal(output.at(-1), 'one\n\ntwo')
  mock.timers.tick(2500)
  assert.equal(output.at(-1), 'three\n\nfour')
  mock.timers.tick(10_000)
  assert.equal(output.length, 2)
})

test('suspend cancels queued pages; resume waits for fresh confirmed text', () => {
  const { pager, output } = setup()
  pager.update('one\ntwo\nthree')
  pager.suspend()
  mock.timers.tick(10_000)
  pager.resume()
  pager.update('one\ntwo\nthree')
  mock.timers.tick(10_000)
  assert.deepEqual(output, ['one\ntwo'])
  pager.update('one\ntwo\nthree\nfour')
  assert.equal(output.at(-1), 'three\nfour')
})

test('configure reflows the current page without replaying earlier pages', () => {
  const { pager, output } = setup()
  pager.update('one\ntwo\nthree\nfour\nfive')
  mock.timers.tick(2500)
  pager.configure({ rows: 3 })
  assert.equal(output.at(-1), 'three\nfour\nfive')
  assert.equal(output.filter(text => text.includes('one')).length, 1)
})

test('reset starts a new session immediately; dispose cancels pending callbacks', () => {
  const { pager, output } = setup()
  pager.update('one\ntwo\nthree')
  pager.suspend()
  pager.reset()
  pager.update('new session')
  assert.equal(output.at(-1), 'new session')
  pager.update('new session\nsecond\nthird')
  pager.dispose()
  mock.timers.tick(10_000)
  pager.update('ignored')
  assert.deepEqual(output, ['one\ntwo', 'new session'])
})

test('one narrow row still consumes speech when a continuation label cannot fit', () => {
  const { pager, output } = setup(1, 10)
  pager.update('Speaker 1: hello again')
  for (let i = 0; i < 5; i++) mock.timers.tick(2500)
  assert.ok(output.some(text => text.includes('hello')))
  assert.ok(output.some(text => text.includes('again')))
  assert.ok(output.length < 6)
})
