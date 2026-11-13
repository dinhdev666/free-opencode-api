/**
 * A client that disconnects mid-request must not leak an opencode session.
 *
 * opencode keeps a session for every turn. A client that goes away leaves
 * that session half-finished, so the proxy has to clean it up.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeClient } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

let mock
let oc
let app
let baseUrl

test.before(async () => {
  mock = await startMockProvider({ reply: "answer" })
  oc = await startOpencodeWithMock(mock)

  const client = oc.client()
  const registry = new ModelRegistry()
  registry.update(await client.providers())

  app = buildServer({ client, registry, eventBus: new EventBus(client) })
  await app.listen({ host: "127.0.0.1", port: 0 })
  baseUrl = `http://127.0.0.1:${app.server.address().port}/v1/chat/completions`
})

test.after(async () => {
  await app?.opencode?.eventBus?.close()
  await app?.close()
  await oc?.close()
  await mock?.close()
})

/**
 * The number of sessions opencode is holding.
 *
 * The route is project-scoped, so the directory has to be passed — otherwise
 * the answer belongs to a different project. An empty body means the server
 * is busy rebuilding the instance, which counts as no sessions.
 */
async function sessionCount() {
  const response = await fetch(`http://127.0.0.1:${oc.port}/session?directory=${encodeURIComponent(oc.dir)}`)
  const text = await response.text()
  if (!text) return 0
  const list = JSON.parse(text)
  return Array.isArray(list) ? list.length : 0
}

test("a client that disconnects leaves no session behind", async () => {
  const before = await sessionCount()

  for (let i = 0; i < 5; i++) {
    const controller = new AbortController()
    fetch(baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: `Hello ${i}` }],
      }),
      signal: controller.signal,
    }).catch(() => {})

    await new Promise((resolve) => setTimeout(resolve, 40))
    controller.abort()
    await new Promise((resolve) => setTimeout(resolve, 120))
  }

  // Give the proxy time to notice the disconnects and clean up. A loaded
  // runner needs more than a moment.
  await waitForSessions(before + 1)

  const after = await sessionCount()
  assert.ok(
    after - before <= 1,
    `expected the abandoned sessions to be cleaned up, found ${after - before} left over`,
  )
})

/**
 * Waits until the session count drops to at most `target`.
 *
 * The cleanup is a network round trip to opencode, so a loaded runner needs
 * more than a moment.
 */
async function waitForSessions(target, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if ((await sessionCount()) <= target) return
    } catch {
      // The server is busy rebuilding the instance; try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

test("a completed request still works and keeps its session", async () => {
  // A request right after an abandoned one can still be disturbed by the
  // cleanup, so give it a moment.
  await waitForSessions(1)

  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  })

  if (res.status !== 200) {
    const body = await res.json()
    assert.equal(res.status, 200, `unexpected status ${res.status}: ${body.error?.message}`)
  }

  const body = await res.json()
  assert.equal(body.choices[0].message.content, "answer")
})
