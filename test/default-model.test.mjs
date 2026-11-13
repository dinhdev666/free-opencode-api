/**
 * The `DEFAULT_MODEL` fallback.
 *
 * A client may leave out the model. The proxy then uses the configured
 * default, and says so when there is none.
 */

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
  mock = await startMockProvider({ reply: "Hello from mock" })
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

test("a request without a model is refused when no default is configured", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }),
  })

  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, "model_required")
  assert.equal(body.error.param, "model")
})

test("an empty model is treated like no model at all", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "", messages: [{ role: "user", content: "Hello" }] }),
  })

  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.error.code, "model_required")
})
