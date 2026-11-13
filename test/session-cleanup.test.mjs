// Does a disconnected client leave a session behind?
//
// The cleanup disposes the opencode instance and then deletes the session.
// The order matters: a delete that meets the broken instance fails, and the
// session stays behind forever.

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
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

/** The number of sessions opencode is holding. */
async function sessionCount() {
  const response = await fetch(`http://127.0.0.1:${oc.port}/session?directory=${encodeURIComponent(oc.dir)}`)
  const text = await response.text()
  if (!text) return 0
  const list = JSON.parse(text)
  return Array.isArray(list) ? list.length : 0
}

test("a disconnected client leaves no session behind", async () => {
  const before = await sessionCount()

  const controller = new AbortController()
  fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
    signal: controller.signal,
  }).catch(() => {})

  await new Promise((resolve) => setTimeout(resolve, 40))
  controller.abort()

  // The cleanup is a network round trip to opencode.
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if ((await sessionCount()) <= before) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  const after = await sessionCount()
  assert.ok(
    after <= before,
    `expected the abandoned session to be cleaned up, found ${after - before} left over`,
  )
})
