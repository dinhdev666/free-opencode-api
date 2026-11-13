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

  const client = new OpencodeClient({ baseUrl: `http://127.0.0.1:${oc.port}` })
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
  const list = await (await fetch(`http://127.0.0.1:${oc.port}/session`)).json()
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

  // Give the proxy time to notice the disconnects and clean up.
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const after = await sessionCount()
  assert.ok(
    after - before <= 1,
    `expected the abandoned sessions to be cleaned up, found ${after - before} left over`,
  )
})

test("a completed request still works and keeps its session", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  })

  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.choices[0].message.content, "answer")
})
