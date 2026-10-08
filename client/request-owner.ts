/** A response belongs to one mounted scope and one request, not just one URL.
 * RPC faces without AbortSignal support still use owns() to discard late results.
 */
export class RequestOwner {
  private current: AbortController | null = null

  begin(): { signal: AbortSignal; owns: () => boolean } {
    this.cancel()
    const controller = new AbortController()
    this.current = controller
    return {
      signal: controller.signal,
      owns: () => this.current === controller && !controller.signal.aborted,
    }
  }

  cancel(): void {
    this.current?.abort()
    this.current = null
  }
}
