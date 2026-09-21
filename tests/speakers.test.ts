import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeSpeakerName } from '../src/speakers.ts'

test('names preserve Russian and accented text while excluding caption delimiters and controls', () => {
  assert.equal(normalizeSpeakerName('  Джон  Смит  '), 'Джон Смит')
  assert.equal(normalizeSpeakerName('Jose\u0301'), 'José')
  assert.equal(normalizeSpeakerName('Mary-Jane O’Neil'), 'Mary-Jane O’Neil')
  for (const invalid of ['', 'John: speaker 2', 'John\nOther', '<script>', 'John\u202e', 'a'.repeat(41), '123']) {
    assert.equal(normalizeSpeakerName(invalid), '', invalid)
  }
})
