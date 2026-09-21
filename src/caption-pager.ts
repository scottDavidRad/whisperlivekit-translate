export interface CaptionPagerOptions {
  rows: number
  /** Wrap plain text without changing its words or their order. */
  wrap: (text: string) => string[]
  dwellMs?: number
  updateMs?: number
}

interface Page { text: string; end: number; full: boolean; overflow: boolean }

function normalize(text: string): string {
  return text.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n')
}

/** A saved identity can rename several earlier turns at once. Align the read
 * cursor by speech characters so these metadata changes never replay a page. */
function speechPositions(text: string): { text: string; positions: number[] } {
  const positions: number[] = []
  let previous = 0
  for (const match of text.matchAll(/(?:^|\n)(?:Speaker (?:\d+|pending)|[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,39}): ?/gu)) {
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    for (let i = previous; i < start; i++) positions.push(i)
    previous = match.index + match[0].length
  }
  for (let i = previous; i < text.length; i++) positions.push(i)
  return { text: positions.map(index => text[index]).join(''), positions }
}

/** A display cursor over cumulative, revisable confirmed speech. Phone history
 * remains authoritative; only unread text is paginated here. */
export class CaptionPager {
  private options: Required<CaptionPagerOptions>
  private source = ''
  private cursor = 0
  private published = ''
  private publishedAt: number | undefined
  private fullSince: number | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private suspended = false
  private awaitingFresh = false
  private disposed = false

  constructor(options: CaptionPagerOptions, private onChange: (text: string) => void) {
    this.options = this.validated({ dwellMs: 2500, updateMs: 700, ...options })
  }

  private validated(options: Required<CaptionPagerOptions>): Required<CaptionPagerOptions> {
    if (!Number.isFinite(options.rows) || options.rows < 1) throw new Error('Caption rows must be positive.')
    if (!Number.isFinite(options.dwellMs) || options.dwellMs < 0 ||
        !Number.isFinite(options.updateMs) || options.updateMs < 0) throw new Error('Caption delays must be nonnegative.')
    return { ...options, rows: Math.floor(options.rows) }
  }

  update(confirmedText: string) {
    if (this.disposed) return
    const next = normalize(confirmedText)
    const changed = next !== this.source
    if (changed) {
      this.reconcileCursor(this.source, next)
      this.source = next
    }
    if (this.suspended || (this.awaitingFresh && !changed)) return
    this.awaitingFresh = false
    this.flush()
  }

  configure(options: Partial<CaptionPagerOptions>) {
    if (this.disposed) return
    this.options = this.validated({ ...this.options, ...options })
    this.publishedAt = undefined
    this.fullSince = undefined
    if (!this.suspended && !this.awaitingFresh) this.flush()
  }

  suspend() {
    if (this.disposed) return
    this.suspended = true
    this.cancelTimer()
  }

  resume() {
    if (this.disposed || !this.suspended) return
    this.suspended = false
    this.awaitingFresh = true
  }

  reset() {
    if (this.disposed) return
    this.cancelTimer()
    this.source = ''
    this.cursor = 0
    this.published = ''
    this.publishedAt = undefined
    this.fullSince = undefined
    this.suspended = false
    this.awaitingFresh = false
  }

  dispose() { this.cancelTimer(); this.disposed = true }

  private cancelTimer() { clearTimeout(this.timer); this.timer = undefined }

  private schedule(delay: number) {
    this.timer = setTimeout(() => { this.timer = undefined; this.flush() }, Math.max(0, delay))
  }

  private reconcileCursor(previous: string, next: string) {
    // Locate the changed interval. Edits before an already-read page shift its
    // cursor; they must not replay the beginning or append a duplicate snapshot.
    let prefix = 0
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
    if (this.cursor <= prefix) return
    if (this.cursor > 0 && previous !== next) {
      const before = speechPositions(previous)
      const after = speechPositions(next)
      if (before.text && after.text.startsWith(before.text)) {
        const offset = before.positions.findIndex(position => position >= this.cursor)
        this.cursor = offset < 0 ? (after.positions[before.positions.length] ?? next.length)
          : (after.positions[offset] ?? next.length)
        return
      }
    }
    let suffix = 0
    while (suffix < previous.length - prefix && suffix < next.length - prefix &&
           previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
    if (this.cursor >= previous.length - suffix) this.cursor += next.length - previous.length
    else {
      // A past correction and newly appended speech can remove the common
      // suffix even though the current unread text itself survives unchanged.
      // Use that anchor only when it is substantial and unique in both texts.
      const anchor = previous.slice(this.cursor)
      const found = anchor.trim().length >= 8 && previous.indexOf(anchor) === this.cursor
        ? next.indexOf(anchor) : -1
      if (found >= 0 && next.lastIndexOf(anchor) === found) {
        this.cursor = found
        return
      }
      // The page anchor itself was replaced. Show the replacement from its
      // changed word, instead of keeping an offset into unrelated new wording.
      this.cursor = prefix
      while (this.cursor > 0 && !/\s/.test(next[this.cursor - 1])) this.cursor--
    }
    this.cursor = Math.max(0, Math.min(this.cursor, next.length))
  }

  private page(includeContinuationLabel = true): Page {
    let start = this.cursor
    while (/\s/.test(this.source[start] ?? '') && start < this.source.length) start++
    let speaker = ''
    for (const match of this.source.slice(0, start).matchAll(/(?:^|\n)((?:Speaker (?:\d+|pending)|[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,39}):)/gu)) speaker = match[1]
    const remaining = this.source.slice(start)
    const prefix = includeContinuationLabel && speaker && !/^(?:Speaker (?:\d+|pending)|[\p{L}\p{M}][\p{L}\p{M} '\u2019-]{0,39}):/u.test(remaining)
      ? `${speaker} ` : ''
    const display = prefix + remaining
    const lines: string[] = []
    let end = start
    let position = 0
    for (const wrapped of this.options.wrap(display)) {
      const line = wrapped.trim()
      if (line) {
        const found = display.indexOf(line, position)
        position = (found >= 0 ? found : position) + line.length
        end = start + Math.max(0, Math.min(remaining.length, position - prefix.length))
      } else if (!lines.length) continue
      // Blank rows provided by the wrapper are intentional sentence spacing.
      lines.push(line)
      if (lines.length >= this.options.rows) break
    }
    // A one-row, very narrow display must still advance if a repeated speaker
    // label would otherwise occupy the entire page by itself.
    if (includeContinuationLabel && lines.length && end <= start) return this.page(false)
    while (end < this.source.length && /\s/.test(this.source[end])) end++
    return { text: lines.join('\n'), end, full: lines.length >= this.options.rows, overflow: end < this.source.length }
  }

  private flush() {
    this.cancelTimer()
    if (this.disposed || this.suspended || this.awaitingFresh) return
    const now = Date.now()
    let page = this.page()
    let advanced = false
    if (page.text === this.published && page.overflow && this.fullSince !== undefined &&
        now - this.fullSince >= this.options.dwellMs) {
      this.cursor = page.end
      page = this.page()
      this.fullSince = undefined
      advanced = true
    }
    const changed = page.text !== this.published
    if (changed || advanced) {
      const due = this.publishedAt === undefined || advanced ? now : this.publishedAt + this.options.updateMs
      if (now < due) { this.schedule(due - now); return }
      this.published = page.text
      this.publishedAt = now
      this.fullSince = page.full ? now : undefined
      this.onChange(page.text)
      // Callbacks may synchronously suspend, reset, or dispose the pager.
      if (this.disposed || this.suspended || this.awaitingFresh || this.published !== page.text) return
    } else if (page.full && this.fullSince === undefined) this.fullSince = now
    else if (!page.full) this.fullSince = undefined
    if (page.overflow && this.fullSince !== undefined) this.schedule(this.options.dwellMs - (now - this.fullSince))
  }
}
