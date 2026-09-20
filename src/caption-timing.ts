/** Clears the lens after text stops changing; repeated server snapshots do not
 * extend the reading time. A zero delay keeps the current captions visible. */
export class CaptionTiming {
  private timer: ReturnType<typeof setTimeout> | undefined
  private text = ''
  hidden = false
  constructor(private seconds: number, private onClear: () => void) {}
  update(text: string) {
    if (text === this.text) return
    this.text = text
    this.hidden = false
    this.arm()
  }
  configure(seconds: number) {
    this.seconds = seconds
    this.hidden = false
    this.arm()
  }
  private arm() {
    clearTimeout(this.timer)
    if (this.seconds > 0 && this.text.trim()) {
      this.timer = setTimeout(() => this.clear(), this.seconds * 1000)
    }
  }
  clear() {
    clearTimeout(this.timer)
    this.hidden = true
    this.onClear()
  }
  reset() { clearTimeout(this.timer); this.text = ''; this.hidden = false }
  dispose() { clearTimeout(this.timer) }
}
