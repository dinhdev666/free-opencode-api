/**
 * End-to-end tests for the OpenAI-compatible proxy, driven by a mock provider
 * so they need neither network access nor a provider quota.
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

async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

test("GET /v1/models lists opencode models in OpenAI shape", async () => {
  const res = await fetch(`${baseUrl}/v1/models`, { headers: authHeaders() })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.object, "list")
  assert.ok(Array.isArray(body.data))
  const mockModel = body.data.find((m) => m.id === "mock/mock-model")
  assert.ok(mockModel, "expected mock/mock-model in the model list")
  assert.equal(mockModel.object, "model")
  assert.equal(typeof mockModel.created, "number")
  assert.equal(typeof mockModel.owned_by, "string")
})

test("GET /health reports the opencode server status", async () => {
  const res = await fetch(`${baseUrl}/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, "ok")
  assert.equal(body.opencode.healthy, true)
})

test("POST /v1/chat/completions returns an OpenAI-shaped completion", async () => {
  const { status, body } = await post("/v1/chat/completions", {
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
  })

  assert.equal(status, 200)
  assert.equal(body.object, "chat.completion")
  assert.equal(body.model, "mock/mock-model")
  assert.equal(typeof body.id, "string")
  assert.equal(body.choices.length, 1)
  assert.equal(body.choices[0].index, 0)
  assert.equal(body.choices[0].message.role, "assistant")
  assert.equal(body.choices[0].message.content, "Hello from mock")
  assert.equal(body.choices[0].finish_reason, "stop")
  assert.equal(typeof body.usage.prompt_tokens, "number")
  assert.equal(typeof body.usage.completion_tokens, "number")
})

test("POST /v1/chat/completions rejects a request without messages", async () => {
  const { status, body } = await post("/v1/chat/completions", { model: "mock/mock-model" })
  assert.equal(status, 400)
  assert.equal(body.error.type, "invalid_request_error")
})

test("POST /v1/chat/completions rejects an unknown model", async () => {
  const { status, body } = await post("/v1/chat/completions", {
    model: "does-not-exist",
    messages: [{ role: "user", content: "Hello" }],
  })
  assert.equal(status, 404)
  assert.equal(body.error.code, "model_not_found")
})

test("POST /v1/chat/completions streams SSE chunks", async () => {
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
  assert.match(res.headers.get("content-type"), /text\/event-stream/)

  const text = await res.text()
  assert.match(text, /^data: /m)
  assert.match(text, /data: \[DONE\]/)

  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))

  assert.ok(chunks.length > 0)
  assert.equal(chunks[0].object, "chat.completion.chunk")
  assert.equal(chunks[0].model, "mock/mock-model")

  const content = chunks
    .flatMap((c) => c.choices ?? [])
    .map((c) => c.delta?.content ?? "")
    .join("")
  assert.match(content, /Hello from mock/)

  const final = chunks.filter((c) => c.choices?.some((choice) => choice.finish_reason)).at(-1)
  assert.equal(final.choices[0].finish_reason, "stop")

  const usageChunk = chunks.find((c) => c.usage)
  assert.ok(usageChunk, "expected a final usage chunk")
  assert.equal(typeof usageChunk.usage.total_tokens, "number")
})

test("POST /v1/completions returns a text completion", async () => {
  const { status, body } = await post("/v1/completions", {
    model: "mock/mock-model",
    prompt: "Hello",
  })
  assert.equal(status, 200)
  assert.equal(body.object, "text_completion")
  assert.equal(body.choices[0].text, "Hello from mock")
})

test("POST /v1/completions streams text_completion chunks", async () => {
  const res = await fetch(`${baseUrl}/v1/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      prompt: "Hello",
      stream: true,
    }),
  })

  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)

  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))

  assert.ok(chunks.length > 0)
  assert.equal(chunks[0].object, "text_completion")
  const content = chunks.map((c) => c.choices?.[0]?.text ?? "").join("")
  assert.match(content, /Hello from mock/)
})

test("a model id with a #variant suffix resolves", async () => {
  const { status, body } = await post("/v1/chat/completions", {
    model: "mock/mock-model#high",
    messages: [{ role: "user", content: "Hello" }],
  })
  assert.equal(status, 200)
  assert.equal(body.model, "mock/mock-model")
})

test("the system message reaches the model", async () => {
  mock.requests.length = 0
  await post("/v1/chat/completions", {
    model: "mock/mock-model",
    messages: [
      { role: "system", content: "You are a pirate." },
      { role: "user", content: "Hello" },
    ],
  })

  const request = mock.requests.at(-1)
  const roles = (request.body?.messages ?? []).map((m) => m.role)
  assert.ok(roles.includes("system"), "expected a system message in the provider request")
})

test("the streaming content does not echo the user's prompt", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "UNIQUE_PROMPT_MARKER_12345" }],
      stream: true,
    }),
  })

  const text = await res.text()
  const content = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))
    .flatMap((c) => c.choices ?? [])
    .map((c) => c.delta?.content ?? "")
    .join("")

  assert.ok(!content.includes("UNIQUE_PROMPT_MARKER_12345"), "the user prompt must not be echoed")
  assert.match(content, /Hello from mock/)
})

test("one proxy request costs exactly one provider request", async () => {
  mock.requests.length = 0
  await post("/v1/chat/completions", {
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello again" }],
  })

  assert.equal(
    mock.requests.length,
    1,
    "expected a single provider request (no session-title call, no extra round trips)",
  )
})

test("the provider request carries no opencode tools and no skills block", async () => {
  mock.requests.length = 0
  await post("/v1/chat/completions", {
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
  })

  const request = mock.requests.at(-1)
  assert.deepEqual(request.body?.tools ?? [], [], "expected no tool schemas")
  const system = (request.body?.messages ?? []).find((m) => m.role === "system")?.content ?? ""
  assert.ok(!system.includes("<available_skills>"), "expected no <available_skills> block")
  assert.ok(!system.includes("You are a title generator"), "expected no title-generator prompt")
})
