/**
 * Shared subscriber for the opencode server event stream (`GET /event`).
 *
 * The opencode server exposes one global SSE stream carrying every session's
 * events. The proxy multiplexes it: a single connection is kept open and
 * events are dispatched to per-session listeners.
 */

/**
 * Event types the proxy cares about. Everything else is dropped as early as
 * possible — the opencode server emits a lot of noise (plugin catalogues,
 * session diffs, heartbeats) that the proxy never needs.
 */
const INTERESTING = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.status",
  "session.error",
  "session.idle",
])

export class EventBus {
  constructor(client) {
    this.client = client
    this.listeners = new Map() // sessionID -> Set<fn>
    this.controller = null
    this.starting = null
    this.closed = false
  }

  /** Subscribes to events of a single session. Returns an unsubscribe fn. */
  subscribe(sessionID, handler) {
    if (this.closed) return () => {}

    let set = this.listeners.get(sessionID)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionID, set)
    }
    set.add(handler)

    this.#ensureConnected().catch(() => {})

    return () => {
      const current = this.listeners.get(sessionID)
      if (!current) return
      current.delete(handler)
      if (current.size === 0) this.listeners.delete(sessionID)
    }
  }

  async #ensureConnected() {
    if (this.closed) return
    if (this.controller) return
    if (this.starting) return this.starting

    this.starting = (async () => {
      const controller = new AbortController()
      this.controller = controller
      try {
        const { reader } = await this.client.events({ signal: controller.signal })
        const decoder = new TextDecoder()
        let buffer = ""

        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })

          let index
          while ((index = buffer.indexOf("\n\n")) !== -1) {
            const chunk = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            this.#handleChunk(chunk)
          }
        }
      } catch {
        // stream aborted or server gone; the next subscribe() will retry
      } finally {
        if (this.controller === controller) this.controller = null
        this.starting = null
      }
    })()

    return this.starting
  }

  #handleChunk(chunk) {
    for (const line of chunk.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === "[DONE]") continue

      // Cheap pre-filter: skip the JSON parse for events nobody listens to.
      if (!payload.includes('"message.') && !payload.includes('"session.')) continue

      let event
      try {
        event = JSON.parse(payload)
      } catch {
        continue
      }

      if (!INTERESTING.has(event?.type)) continue

      const sessionID = event?.properties?.sessionID
      if (!sessionID) continue
      const handlers = this.listeners.get(sessionID)
      if (!handlers) continue
      for (const handler of handlers) {
        try {
          handler(event)
        } catch {
          // a broken listener must not kill the stream
        }
      }
    }
  }

  async close() {
    this.closed = true
    this.listeners.clear()
    this.controller?.abort()
    this.controller = null
    // Wait for the reader loop to finish so the socket is released before the
    // process is allowed to exit.
    await this.starting?.catch(() => {})
  }
}
