/**
 * End-to-end test for the function-calling emulation.
 *
 * opencode implements structured output by advertising an internal
 * `StructuredOutput` tool whose parameters are the caller's JSON Schema, and
 * by requiring the model to call it. The mock provider therefore has to
 * answer with a tool call carrying the structured payload — exactly like a
 * real provider would.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeClient } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, mark, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

/**
 * Answers a structured-output request with a `StructuredOutput` tool call that
 * carries the structured payload.
 */
function structuredResponder(payload) {
  return (request) => {
    const body = request.body
    const tool = (body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
    if (!tool) return null

    const chunk = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: body.model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_structured_1",
                type: "function",
                function: { name: "StructuredOutput", arguments: JSON.stringify(payload) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
    const done = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }

    return {
      status: 200,
      contentType: "text/event-stream",
      body: `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(done)}\n\ndata: [DONE]\n\n`,
    }
  }
}

let mock
let oc
let app
let baseUrl

test.before(async () => {
  mock = await startMockProvider({
    reply: "plain reply",
    onRequest: structuredResponder({
      content: "Let me look that up.",
      tool_calls: [{ name: "get_weather", arguments: { city: "Paris", unit: "c" } }],
    }),
  })
  mark("tools.test.mjs: starting the mock server")
  oc = await startOpencodeWithMock(mock)
  mark("tools.test.mjs: mock server ready")

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

const WEATHER_TOOL = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" }, unit: { type: "string", enum: ["c", "f"] } },
      required: ["city"],
    },
  },
}

test("a tool-calling request produces OpenAI tool_calls", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "What is the weather in Paris?" }],
      tools: [WEATHER_TOOL],
    }),
  })

  assert.equal(res.status, 200)
  const body = await res.json()
  const message = body.choices[0].message

  assert.equal(body.choices[0].finish_reason, "tool_calls")
  assert.ok(Array.isArray(message.tool_calls))
  assert.equal(message.tool_calls.length, 1)
  assert.equal(message.tool_calls[0].type, "function")
  assert.equal(message.tool_calls[0].function.name, "get_weather")

  const args = JSON.parse(message.tool_calls[0].function.arguments)
  assert.equal(args.city, "Paris")
  assert.equal(args.unit, "c")
})

test("the tool schema reaches the provider as the StructuredOutput parameters", async () => {
  mock.requests.length = 0
  await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [WEATHER_TOOL],
    }),
  })

  const request = mock.requests.at(-1)
  assert.ok(request, "expected a provider request")

  const tool = (request.body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
  assert.ok(tool, "expected a StructuredOutput tool")
  assert.equal(tool.function.parameters.properties.tool_calls.type, "array")
  assert.equal(
    tool.function.parameters.properties.tool_calls.items.anyOf[0].properties.name.const,
    "get_weather",
  )
})

test("no built-in opencode tools are advertised to the provider", async () => {
  mock.requests.length = 0
  await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hi" }],
    }),
  })

  const request = mock.requests.at(-1)
  const names = (request.body?.tools ?? []).map((t) => t.function?.name)
  assert.deepEqual(names, [], "expected no tools for a plain chat request")
})

test("a request without tools does not enable structured output", async () => {
  mock.requests.length = 0
  await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Hi" }],
    }),
  })

  const request = mock.requests.at(-1)
  assert.equal(request.body?.response_format, undefined)
  assert.equal(request.body?.tool_choice, undefined)
})

test("a streaming tool-calling request emits tool_call deltas", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      stream: true,
      tools: [WEATHER_TOOL],
    }),
  })

  assert.equal(res.status, 200)
  const text = await res.text()
  assert.match(text, /data: \[DONE\]/)

  const chunks = text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
    .map((line) => JSON.parse(line.slice(6)))

  const toolDeltas = chunks.flatMap((c) => c.choices ?? []).filter((choice) => choice.delta?.tool_calls)
  assert.ok(toolDeltas.length > 0, "expected tool_call deltas in the stream")
  assert.equal(toolDeltas[0].delta.tool_calls[0].function.name, "get_weather")

  const final = chunks.filter((c) => c.choices?.some((choice) => choice.finish_reason)).at(-1)
  assert.equal(final.choices[0].finish_reason, "tool_calls")
})
