/**
 * Compatibility test against the real OpenAI SDK.
 *
 * The SDK is the strictest consumer of the OpenAI protocol: it validates the
 * response shape and throws on anything it does not understand. Running the
 * real client against the proxy catches the gaps the hand-written tests miss.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeClient } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

/**
 * Answers a structured-output request with a StructuredOutput tool call.
 *
 * The payload has to match what the request asked for: a `json_object`
 * wants the answer wrapped in `content`, a `json_schema` wants the object
 * itself, and a tool call wants it in `tool_calls`.
 */
function structuredResponder(payload) {
  return (request) => {
    const tool = (request.body?.tools ?? []).find((t) => t.function?.name === "StructuredOutput")
    if (!tool) return null

    // The schema of the request says where the answer belongs.
    const schema = tool.function.parameters ?? {}
    const properties = schema.properties ?? {}
    let answer
    if (properties.tool_calls) {
      answer = { tool_calls: payload.tool_calls }
    } else if (properties.content) {
      // The json_object envelope.
      answer = { content: payload.content }
    } else {
      // A json_schema: the object itself.
      answer = JSON.parse(payload.content)
    }

    const base = {
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      created: 1700000000,
      model: request.body.model,
    }
    const chunk = {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_structured_1",
                type: "function",
                function: { name: "StructuredOutput", arguments: JSON.stringify(answer) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }
    const done = {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 },
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
let openai
let OpenAI

test.before(async () => {
  mock = await startMockProvider({
    reply: "Hello from mock",
    onRequest: structuredResponder({
      // The json_object envelope carries the answer in `content`; the
      // tool-calling envelope carries `tool_calls`.
      content: JSON.stringify({ answer: "Hello from mock" }),
      tool_calls: [{ name: "get_weather", arguments: { city: "Paris" } }],
    }),
  })
  oc = await startOpencodeWithMock(mock)

  const client = oc.client()
  const registry = new ModelRegistry()
  registry.update(await client.providers())

  app = buildServer({ client, registry, eventBus: new EventBus(client) })
  await app.listen({ host: "127.0.0.1", port: 0 })
  baseUrl = `http://127.0.0.1:${app.server.address().port}`

  const { default: OpenAIClass } = await import("openai")
  OpenAI = OpenAIClass
  openai = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: "sk-dummy" })
})

test.after(async () => {
  await app?.opencode?.eventBus?.close()
  await app?.close()
  await oc?.close()
  await mock?.close()
})

test("the OpenAI SDK can parse a structured completion", async () => {
  // `parse()` is the SDK's structured-output helper: it sends a
  // `json_schema` response format and parses the answer back.
  const res = await openai.chat.completions.parse({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "answer",
        strict: true,
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
          additionalProperties: false,
        },
      },
    },
  })

  assert.deepEqual(res.choices[0].message.parsed, { answer: "Hello from mock" })
  assert.equal(res.choices[0].finish_reason, "stop")
})

test("the OpenAI SDK can list the models", async () => {
  const list = await openai.models.list()
  assert.ok(list.data.length > 0)
  assert.ok(list.data.some((m) => m.id === "mock/mock-model"))
})

test("the OpenAI SDK can retrieve a single model", async () => {
  // A model id contains a slash, so the route has to accept the whole path.
  const qualified = await openai.models.retrieve("mock/mock-model")
  assert.equal(qualified.id, "mock/mock-model")
  assert.equal(qualified.object, "model")

  const bare = await openai.models.retrieve("mock-model")
  assert.equal(bare.id, "mock/mock-model")
})

test("the OpenAI SDK can run a chat completion", async () => {
  const res = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
  })
  assert.equal(res.choices[0].message.content, "Hello from mock")
  assert.equal(res.choices[0].message.role, "assistant")
  assert.equal(res.choices[0].finish_reason, "stop")
  assert.equal(typeof res.usage.prompt_tokens, "number")
  assert.equal(typeof res.usage.total_tokens, "number")
})

test("the OpenAI SDK can stream a chat completion", async () => {
  const stream = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
  })

  let text = ""
  let firstRole
  for await (const chunk of stream) {
    if (firstRole === undefined) firstRole = chunk.choices[0]?.delta?.role
    text += chunk.choices[0]?.delta?.content ?? ""
  }
  assert.equal(firstRole, "assistant")
  assert.match(text, /Hello from mock/)
})

test("the OpenAI SDK can stream with usage", async () => {
  const stream = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
    stream_options: { include_usage: true },
  })

  let usage
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage
  }
  assert.ok(usage, "expected a usage chunk")
  assert.equal(typeof usage.total_tokens, "number")
})

test("the OpenAI SDK can send the usual request knobs", async () => {
  const res = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 100,
    temperature: 0.7,
    top_p: 0.9,
    seed: 42,
    user: "someone",
    n: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    stop: ["\n\n"],
    logprobs: false,
    parallel_tool_calls: true,
  })
  assert.equal(res.choices[0].message.content, "Hello from mock")
})

test("the OpenAI SDK can request a tool call", async () => {
  const res = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "What is the weather in Paris?" }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      },
    ],
  })

  assert.equal(res.choices[0].finish_reason, "tool_calls")
  const call = res.choices[0].message.tool_calls[0]
  assert.equal(call.type, "function")
  assert.equal(call.function.name, "get_weather")
  assert.deepEqual(JSON.parse(call.function.arguments), { city: "Paris" })
})

test("the OpenAI SDK can request JSON mode", async () => {
  const res = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    response_format: { type: "json_object" },
  })
  // The answer must be valid JSON.
  assert.doesNotThrow(() => JSON.parse(res.choices[0].message.content))
})

test("the OpenAI SDK sees a well-shaped error for an unknown model", async () => {
  await assert.rejects(
    () =>
      openai.chat.completions.create({
        model: "does-not-exist",
        messages: [{ role: "user", content: "Hello" }],
      }),
    (err) => {
      assert.equal(err.status, 404)
      assert.equal(err.error?.code, "model_not_found")
      assert.equal(typeof err.error?.message, "string")
      return true
    },
  )
})

test("the OpenAI SDK sees a well-shaped error for a wrong API key", async () => {
  const bad = new OpenAI({ baseURL: `${baseUrl}/v1`, apiKey: "wrong" })
  await assert.rejects(
    () =>
      bad.chat.completions.create({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
    (err) => {
      assert.equal(err.status, 401)
      assert.equal(err.error?.code, "invalid_api_key")
      return true
    },
  )
})

test("a request without an API key is rejected", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "mock/mock-model", messages: [{ role: "user", content: "Hello" }] }),
  })
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, "invalid_api_key")
  // The OpenAI error shape carries a `param` field.
  assert.ok("param" in body.error)
})

test("the key has to come as a bearer token", async () => {
  // The OpenAI standard sends the key in the Authorization header. Other
  // schemes are not accepted.
  const res = await fetch(`${baseUrl}/v1/models`, {
    headers: { "x-api-key": "sk-dummy" },
  })

  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, "invalid_api_key")
})

test("an error body matches the OpenAI error shape", async () => {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ model: "mock/mock-model" }),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(typeof body.error.message, "string")
  assert.equal(typeof body.error.type, "string")
  assert.ok("param" in body.error)
  assert.ok("code" in body.error)
})
