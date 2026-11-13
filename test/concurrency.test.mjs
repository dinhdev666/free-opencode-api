/**
 * Several clients at the same time.
 *
 * The proxy keeps one opencode session per request and multiplexes the
 * events, so a request must never see another request's answer.
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

test("concurrent requests all succeed", async () => {
  mock.requests.length = 0

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      fetch(baseUrl, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "mock/mock-model",
          messages: [{ role: "user", content: `Hello ${index}` }],
        }),
      }).then(async (res) => ({ status: res.status, body: await res.json() })),
    ),
  )

  for (const [index, result] of results.entries()) {
    assert.equal(result.status, 200, `request ${index} failed`)
    assert.equal(result.body.choices[0].message.content, "Hello from mock")
    assert.equal(result.body.choices[0].index, 0)
  }

  // Every request costs exactly one provider request.
  assert.equal(mock.requests.length, 8)
})

test("a stream and a normal request do not mix", async () => {
  const plain = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "plain" }],
    }),
  }).then(async (res) => ({ status: res.status, body: await res.json() }))

  const streamed = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "stream" }],
      stream: true,
    }),
  }).then(async (res) => ({ status: res.status, text: await res.text() }))

  assert.equal(plain.status, 200)
  assert.equal(plain.body.choices[0].message.content, "Hello from mock")

  assert.equal(streamed.status, 200)
  // The content arrives in pieces, so the pieces are collected first.
  const chunks = streamed.text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))
  const content = chunks
    .flatMap((chunk) => chunk.choices ?? [])
    .map((choice) => choice.delta?.content ?? "")
    .join("")
  assert.equal(content, "Hello from mock")
})
