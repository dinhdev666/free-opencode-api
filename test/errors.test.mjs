/**
 * Tests for the error paths: a failing upstream provider has to surface as a
 * sensible OpenAI-style error rather than a generic 500.
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
  mock = await startMockProvider({
    onRequest: () => ({
      status: 429,
      body: JSON.stringify({
        error: { message: "Free usage limit reached. Free models work in OpenCode." },
      }),
    }),
  })
  oc = await startOpencodeWithMock(mock)

  const client = new OpencodeClient({ baseUrl: `http://127.0.0.1:${oc.port}` })
  const registry = new ModelRegistry()
  registry.update(await client.providers())

  app = buildServer({ client, registry, eventBus: new EventBus(client) })
  await app.listen({ host: "127.0.0.1", port: 0 })
  baseUrl = `http://127.0.0.1:${app.server.address().port}`
})

test.after(async () => {
  await app?.opencode?.eventBus?.close()
  await app?.close()
  await oc?.close()
  await mock?.close()
})

test("a rate-limited provider surfaces as HTTP 429", async () => {
  const started = Date.now()
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hello" }],
    }),
  })

  const body = await res.json()
  assert.equal(res.status, 429)
  assert.ok(body.error, "expected an error object")
  assert.equal(body.error.code, "provider_rate_limited")
  assert.match(body.error.message, /usage limit|rate limit|quota/i)

  // opencode retries a failing provider for minutes; the proxy has to notice
  // the failure on its own instead of waiting for the request timeout.
  const elapsed = Date.now() - started
  assert.ok(elapsed < 60_000, `expected a fast failure, took ${elapsed}ms`)
})

test("a rate-limited provider surfaces as an error chunk while streaming", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    }),
  })

  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /"error"/)
  assert.match(text, /provider_rate_limited/)
  assert.match(text, /data: \[DONE\]/)
})

test("an unreachable opencode server surfaces as HTTP 503", async () => {
  const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:1" })
  const registry = new ModelRegistry()
  registry.update({
    all: [{ id: "mock", name: "Mock", models: { "mock-model": { name: "Mock" } } }],
    connected: ["mock"],
  })

  const local = buildServer({ client, registry, eventBus: new EventBus(client) })
  await local.listen({ host: "127.0.0.1", port: 0 })
  const url = `http://127.0.0.1:${local.server.address().port}`

  try {
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
    })
    const body = await res.json()
    assert.ok(res.status >= 500, `expected a 5xx status, got ${res.status}`)
    assert.ok(body.error, "expected an error object")
  } finally {
    await local.opencode.eventBus.close()
    await local.close()
  }
})
