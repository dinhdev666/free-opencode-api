/**
 * Minimal HTTP client for the opencode server (`opencode serve`).
 *
 * The opencode server speaks JSON over HTTP and exposes an OpenAPI 3.1 spec
 * at `/doc`. We deliberately avoid pulling in the generated SDK: the proxy
 * only needs a handful of endpoints and keeping the dependency surface tiny
 * is a hard requirement for this project.
 */

import { config, opencodeBaseUrl } from "./config.js"

export class OpencodeError extends Error {
  constructor(message, { status = 500, code = "opencode_error", body } = {}) {
    super(message)
    this.name = "OpencodeError"
    this.status = status
    this.code = code
    this.body = body
  }
}

function authHeader() {
  if (!config.opencodePassword) return undefined
  const raw = `${config.opencodeUsername}:${config.opencodePassword}`
  return `Basic ${Buffer.from(raw).toString("base64")}`
}

export class OpencodeClient {
  constructor({ baseUrl = opencodeBaseUrl } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.token = authHeader()
  }

  async request(path, { method = "GET", body, signal, timeout } = {}) {
    const headers = { accept: "application/json" }
    if (body !== undefined) headers["content-type"] = "application/json"
    if (this.token) headers.authorization = this.token

    const controller = new AbortController()
    const timer = timeout ? setTimeout(() => controller.abort(), timeout) : undefined
    const onAbort = () => controller.abort()
    if (signal && typeof signal.addEventListener === "function") {
      if (signal.aborted) controller.abort()
      else signal.addEventListener("abort", onAbort, { once: true })
    }

    let response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new OpencodeError(
          `The opencode server did not answer within ${Math.round((timeout ?? 0) / 1000)}s. ` +
            "opencode retries a failing provider automatically, so a slow or rate-limited " +
            "provider can take a long time. Raise REQUEST_TIMEOUT or try another model.",
          { status: 504, code: "timeout" },
        )
      }
      throw new OpencodeError(`cannot reach opencode server at ${this.baseUrl}: ${err?.message}`, {
        status: 503,
        code: "unavailable",
      })
    } finally {
      if (timer) clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", onAbort)
    }

    const text = await response.text()
    let payload
    if (text) {
      try {
        payload = JSON.parse(text)
      } catch {
        payload = text
      }
    }

    if (!response.ok) {
      const detail =
        (payload && typeof payload === "object" && (payload.message || payload.data?.message)) ||
        (typeof payload === "string" ? payload : "") ||
        `HTTP ${response.status}`
      throw new OpencodeError(detail || `HTTP ${response.status}`, {
        status: response.status,
        code: "opencode_error",
        body: payload,
      })
    }
    return payload
  }

  health() {
    return this.request("/global/health", { timeout: 5000 })
  }

  /** Returns { all: Provider[], default: {...}, connected: string[] } */
  providers() {
    return this.request("/provider", { timeout: 30000 })
  }

  /** Built-in tool ids known to the running opencode build. */
  toolIds() {
    return this.request("/experimental/tool/ids", { timeout: 10000 })
  }

  /**
   * Creates a session.
   *
   * Passing a title suppresses opencode's automatic title generation, which
   * would otherwise trigger a second, completely wasted LLM call.
   */
  createSession(title) {
    return this.request("/session", {
      method: "POST",
      body: title ? { title } : {},
      timeout: 30000,
    })
  }

  /**
   * Deletes a session.
   *
   * Sessions are disposable, but deleting every one of them costs an extra
   * request per completion. The proxy therefore only deletes them when asked
   * to; opencode keeps them until it prunes its own history.
   */
  deleteSession(id) {
    return this.request(`/session/${id}`, { method: "DELETE", timeout: 15000 }).catch(() => false)
  }

  abortSession(id) {
    return this.request(`/session/${id}/abort`, { method: "POST", timeout: 10000 }).catch(() => false)
  }

  /**
   * Sends a prompt and waits for the full assistant reply.
   * Returns `{ info, parts }`.
   */
  prompt(sessionID, payload, { signal } = {}) {
    return this.request(`/session/${sessionID}/message`, {
      method: "POST",
      body: payload,
      signal,
      timeout: config.requestTimeout,
    })
  }

  /**
   * Sends a prompt without waiting for the reply (HTTP 204).
   *
   * The reply then arrives on the event stream, which lets the proxy react to
   * a failing provider as soon as opencode reports it.
   */
  async promptAsync(sessionID, payload, { signal } = {}) {
    await this.request(`/session/${sessionID}/prompt_async`, {
      method: "POST",
      body: payload,
      signal,
      timeout: 30000,
    })
  }

  /**
   * Status of every session of the current project, keyed by session id.
   *
   * The endpoint is project-scoped, so the working directory has to be passed
   * explicitly — otherwise the proxy's own directory is used and the sessions
   * it created are invisible.
   */
  async sessionStatus(directory = config.workdir) {
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const payload = await this.request(`/session/status${query}`, { timeout: 10000 }).catch(() => ({}))
    return payload ?? {}
  }

  /**
   * Opens the opencode server-sent event stream.
   * Returns `{ response, reader }` — the caller owns `reader.cancel()`.
   */
  async events({ signal } = {}) {
    const headers = { accept: "text/event-stream" }
    if (this.token) headers.authorization = this.token

    const response = await fetch(`${this.baseUrl}/event`, { headers, signal })
    if (!response.ok || !response.body) {
      throw new OpencodeError(`cannot subscribe to opencode events (HTTP ${response.status})`, {
        status: 502,
        code: "event_stream_failed",
      })
    }
    return { response, reader: response.body.getReader() }
  }
}
