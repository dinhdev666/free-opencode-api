/**
 * End-to-end test for the OpenAI `response_format` field.
 *
 * opencode implements structured output by asking the model to call an
 * internal `StructuredOutput` tool. The mock provider therefore has to answer
 * with a tool call carrying the structured payload.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeClient } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

/** Answers a structured-output request with a StructuredOutput tool call. */
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
    onRequest: structuredResponder({ content: '{"city":"Paris"}' }),
  })
  oc = await startOpencodeWithMock(mock)

  const client = oc.client()
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

test("response_format json_object returns the JSON answer", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      response_format: { type: "json_object" },
    }),
  })

  assert.equal(res.status, 200)
  const body = await res.json()
  const content = body.choices[0].message.content

  assert.equal(typeof content, "string")
  // The answer must be valid JSON.
  assert.doesNotThrow(() => JSON.parse(content))
})

test("response_format json_schema reaches the provider as a schema", async () => {
  mock.requests.length = 0
  await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "What is the capital of France?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "capital",
          schema: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    }),
  })

  const request = mock.requests.at(-1)
  assert.ok(request, "expected a provider request")

  const tool = (request.body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
  assert.ok(tool, "expected a StructuredOutput tool")
  assert.deepEqual(tool.function.parameters.properties.city, { type: "string" })
})

test("a response_format request wins over nothing else", async () => {
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
  const tool = (request.body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
  assert.equal(tool, undefined, "a plain chat request must not use structured output")
})

test("tools and response_format together return the JSON answer", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model: "mock/mock-model",
      messages: [{ role: "user", content: "Weather in Paris?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            parameters: { type: "object", properties: { city: { type: "string" } } },
          },
        },
      ],
      response_format: { type: "json_object" },
    }),
  })

  assert.equal(res.status, 200)
  const body = await res.json()
  const choice = body.choices[0]

  // The answer is JSON, so the finish reason must not claim a tool call.
  assert.equal(choice.finish_reason, "stop")
  assert.equal(choice.message.tool_calls, undefined)
  assert.doesNotThrow(() => JSON.parse(choice.message.content))
})
