/**
 * Tests for the scenarios that break a chat proxy most often: a tool
 * conversation that spans several turns, and several requests at once.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeClient } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

const REPLY = "The weather in Paris is sunny."

/** Answers a structured-output request with a tool call. */
function toolCallResponder() {
  return (request) => {
    const tool = (request.body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
    if (!tool) return null

    const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1700000000, model: request.body.model }
    const chunk = {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: {
                  name: "StructuredOutput",
                  arguments: JSON.stringify({ tool_calls: [{ name: "get_weather", arguments: { city: "Paris" } }] }),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
    const done = { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }
    return {
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
    }
  }
}

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
}

let mock
let oc
let app
let baseUrl

test.before(async () => {
  mock = await startMockProvider({ reply: REPLY, onRequest: toolCallResponder() })
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

function post(body) {
  return fetch(baseUrl, { method: "POST", headers: authHeaders(), body: JSON.stringify(body) }).then((r) => r.json())
}

test("a tool conversation keeps its history across turns", async () => {
  const first = await post({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
    tools: [WEATHER_TOOL],
  })

  assert.equal(first.choices[0].finish_reason, "tool_calls")
  const call = first.choices[0].message.tool_calls[0]
  assert.equal(call.function.name, "get_weather")

  mock.requests.length = 0
  const second = await post({
    model: "mock/mock-model",
    messages: [
      { role: "user", content: "What is the weather in Paris?" },
      { role: "assistant", content: null, tool_calls: [call] },
      { role: "tool", tool_call_id: call.id, name: "get_weather", content: "sunny, 22C" },
    ],
    tools: [WEATHER_TOOL],
  })

  assert.ok(second.choices[0].message, "expected a second answer")

  // The provider has to see the whole conversation.
  const request = mock.requests.at(-1)
  const transcript = request.body.messages
    .map((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : m.content))
    .join("\n")

  assert.match(transcript, /What is the weather in Paris\?/)
  assert.match(transcript, /get_weather/)
  assert.match(transcript, /sunny, 22C/)
})

test("a tool result without a name is matched by its tool_call_id", async () => {
  mock.requests.length = 0
  await post({
    model: "mock/mock-model",
    messages: [
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_xyz", type: "function", function: { name: "get_weather", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_xyz", content: "sunny" },
    ],
  })

  const request = mock.requests.at(-1)
  const transcript = request.body.messages
    .map((m) => (Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : m.content))
    .join("\n")

  assert.match(transcript, /Tool result: get_weather/, "the function name has to be resolved from the call id")
  assert.match(transcript, /sunny/)
})

test("concurrent requests do not mix up their answers", async () => {
  mock.requests.length = 0
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      post({
        model: "mock/mock-model",
        messages: [{ role: "user", content: `request number ${i}` }],
      }),
    ),
  )

  for (const result of results) {
    assert.equal(result.choices[0].message.content, REPLY)
  }
  assert.equal(mock.requests.length, 8, "every request must reach the provider exactly once")
})

test("concurrent streaming requests do not mix up their answers", async () => {
  mock.requests.length = 0
  const streams = await Promise.all(
    Array.from({ length: 5 }, (_, i) =>
      fetch(baseUrl, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          model: "mock/mock-model",
          messages: [{ role: "user", content: `stream ${i}` }],
          stream: true,
        }),
      }).then((r) => r.text()),
    ),
  )

  for (const text of streams) {
    const content = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)))
      .flatMap((chunk) => chunk.choices ?? [])
      .map((choice) => choice.delta?.content ?? "")
      .join("")
    assert.equal(content, REPLY)
  }
})

test("a request with an empty message list is rejected", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "mock/mock-model", messages: [] }),
  })
  assert.equal(res.status, 400)
})

test("concurrent requests trigger a single catalogue refresh", async () => {
  // The catalogue is stale again after the other tests, so the first request
  // has to refresh it. Every request that arrives at the same time has to
  // share that one refresh.
  const registry = app.opencode.registry
  registry.loadedAt = 0

  let refreshes = 0
  const original = registry.update.bind(registry)
  registry.update = (payload) => {
    refreshes++
    return original(payload)
  }

  try {
    await Promise.all(
      Array.from({ length: 8 }, () =>
        post({ model: "mock/mock-model", messages: [{ role: "user", content: "hi" }] }),
      ),
    )
  } finally {
    registry.update = original
  }

  assert.equal(refreshes, 1, "the catalogue must be fetched once, not once per request")
})

test("a message with only tool_calls and no content is accepted", async () => {
  const res = await fetch(baseUrl, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "a", arguments: "{}" } }],
        },
      ],
    }),
  })
  assert.equal(res.status, 200)
})
