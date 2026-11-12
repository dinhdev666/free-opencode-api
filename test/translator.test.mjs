/**
 * Tests for the OpenAI -> opencode translation layer, especially the
 * function-calling emulation built on opencode's structured output.
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  buildResponseFormat,
  buildToolSchema,
  contentToText,
  flattenMessages,
  messagesToParts,
  structuredToJsonMessage,
  structuredToResponse,
  toFinishReason,
} from "../src/translator.js"

test("contentToText handles strings, arrays and missing values", () => {
  assert.equal(contentToText("hello"), "hello")
  assert.equal(contentToText(undefined), "")
  assert.equal(contentToText(null), "")
  assert.equal(
    contentToText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  )
})

test("flattenMessages labels each role", () => {
  const text = flattenMessages([
    { role: "system", content: "be nice" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ])
  assert.match(text, /\[System\]/)
  assert.match(text, /\[User\]/)
  assert.match(text, /\[Assistant\]/)
  assert.match(text, /be nice/)
})

test("messagesToParts turns user content into opencode text parts", () => {
  const parts = messagesToParts([{ role: "user", content: "hello" }])
  assert.equal(parts.length, 1)
  assert.equal(parts[0].type, "text")
  assert.match(parts[0].text, /\[User\]/)
  assert.match(parts[0].text, /hello/)
})

test("messagesToParts converts image content into file parts", () => {
  const parts = messagesToParts([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    },
  ])
  assert.equal(parts.length, 2)
  assert.equal(parts[0].type, "text")
  assert.equal(parts[1].type, "file")
  assert.equal(parts[1].mime, "image/png")
  assert.match(parts[1].url, /^data:image\/png/)
})

test("messagesToParts renders tool results as tool text parts", () => {
  const parts = messagesToParts([
    { role: "tool", tool_call_id: "call_1", name: "get_weather", content: "sunny" },
  ])
  assert.equal(parts.length, 1)
  assert.match(parts[0].text, /get_weather/)
  assert.match(parts[0].text, /sunny/)
})

test("buildToolSchema returns undefined without tools", () => {
  assert.equal(buildToolSchema(undefined, undefined), undefined)
  assert.equal(buildToolSchema([], "auto"), undefined)
})

test("buildToolSchema describes each function with anyOf variants", () => {
  const schema = buildToolSchema(
    [
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
      {
        type: "function",
        function: { name: "search", parameters: { type: "object", properties: { q: { type: "string" } } } },
      },
    ],
    "auto",
  )

  assert.ok(schema)
  assert.equal(schema.type, "object")
  assert.ok(schema.properties.content)
  assert.ok(schema.properties.tool_calls)

  const variants = schema.properties.tool_calls.items.anyOf
  assert.equal(variants.length, 2)
  assert.equal(variants[0].properties.name.const, "get_weather")
  assert.deepEqual(variants[0].properties.arguments.required, ["city"])
  assert.equal(variants[1].properties.name.const, "search")
})

test("buildToolSchema restricts variants to a forced function", () => {
  const schema = buildToolSchema(
    [
      { type: "function", function: { name: "a", parameters: { type: "object" } } },
      { type: "function", function: { name: "b", parameters: { type: "object" } } },
    ],
    { type: "function", function: { name: "b" } },
  )
  const variants = schema.properties.tool_calls.items.anyOf
  assert.equal(variants.length, 1)
  assert.equal(variants[0].properties.name.const, "b")
})

test("buildToolSchema with tool_choice none omits tool calls", () => {
  const schema = buildToolSchema([{ type: "function", function: { name: "a", parameters: { type: "object" } } }], "none")
  assert.equal(schema.properties.tool_calls, undefined)
  assert.ok(schema.properties.content)
})

test("buildToolSchema with tool_choice required demands a tool call", () => {
  const schema = buildToolSchema(
    [{ type: "function", function: { name: "a", parameters: { type: "object" } } }],
    "required",
  )
  assert.deepEqual(schema.required, ["tool_calls"])
  assert.equal(schema.properties.content.type, "null")
  assert.equal(schema.properties.tool_calls.minItems, 1)
})

test("buildToolSchema ignores a tool_choice for an unknown function", () => {
  const schema = buildToolSchema(
    [{ type: "function", function: { name: "a", parameters: { type: "object" } } }],
    { type: "function", function: { name: "missing" } },
  )
  // No variant matches, so no tool call can be produced.
  assert.equal(schema.properties.tool_calls, undefined)
})

test("buildToolSchema normalises a schema without an object type", () => {
  const schema = buildToolSchema(
    [{ type: "function", function: { name: "a", parameters: { properties: { x: { type: "string" } } } } }],
    "auto",
  )
  const args = schema.properties.tool_calls.items.anyOf[0].properties.arguments
  assert.equal(args.type, "object")
  assert.ok(args.properties)
})

test("structuredToResponse maps structured output onto OpenAI tool calls", () => {
  const { content, toolCalls } = structuredToResponse({
    content: "Let me check",
    tool_calls: [{ name: "get_weather", arguments: { city: "Paris" } }],
  })

  assert.equal(content, "Let me check")
  assert.equal(toolCalls.length, 1)
  assert.equal(toolCalls[0].type, "function")
  assert.equal(toolCalls[0].function.name, "get_weather")
  assert.deepEqual(JSON.parse(toolCalls[0].function.arguments), { city: "Paris" })
  assert.match(toolCalls[0].id, /^call_/)
})

test("structuredToResponse keeps string arguments verbatim", () => {
  const { toolCalls } = structuredToResponse({
    content: null,
    tool_calls: [{ name: "a", arguments: '{"x":1}' }],
  })
  assert.equal(toolCalls[0].function.arguments, '{"x":1}')
})

test("structuredToResponse tolerates a missing structured payload", () => {
  const { content, toolCalls } = structuredToResponse(undefined)
  assert.equal(content, "")
  assert.deepEqual(toolCalls, [])
})

test("buildResponseFormat returns undefined without a response_format", () => {
  assert.equal(buildResponseFormat(undefined), undefined)
  assert.equal(buildResponseFormat(null), undefined)
  assert.equal(buildResponseFormat({}), undefined)
  assert.equal(buildResponseFormat({ type: "text" }), undefined)
})

test("buildResponseFormat maps json_object onto a JSON schema", () => {
  const result = buildResponseFormat({ type: "json_object" })
  assert.ok(result)
  assert.equal(result.schema.type, "object")
  assert.ok(result.schema.properties.content)
  assert.equal(result.unwrapContent, true)
})

test("buildResponseFormat maps json_schema onto the given schema", () => {
  const schema = { type: "object", properties: { city: { type: "string" } }, required: ["city"] }
  const result = buildResponseFormat({ type: "json_schema", json_schema: { schema } })
  assert.ok(result)
  assert.equal(result.schema.type, "object")
  assert.deepEqual(result.schema.properties.city, { type: "string" })
  assert.deepEqual(result.schema.required, ["city"])
  assert.equal(result.unwrapContent, false)
})

test("buildResponseFormat normalises a json_schema without a type", () => {
  const result = buildResponseFormat({
    type: "json_schema",
    json_schema: { schema: { properties: { a: { type: "number" } } } },
  })
  assert.equal(result.schema.type, "object")
  assert.ok(result.schema.properties.a)
})

test("structuredToJsonMessage unwraps the json_object envelope", () => {
  assert.equal(structuredToJsonMessage({ content: "hello" }, { unwrapContent: true }), "hello")
  assert.equal(structuredToJsonMessage({ content: null }, { unwrapContent: true }), "")
})

test("structuredToJsonMessage serialises a json_schema answer", () => {
  assert.equal(structuredToJsonMessage({ city: "Paris" }), '{"city":"Paris"}')
  assert.equal(structuredToJsonMessage("already json"), "already json")
})

test("structuredToJsonMessage keeps the whole object without unwrapping", () => {
  assert.equal(structuredToJsonMessage({ content: "hello" }), '{"content":"hello"}')
})

test("toFinishReason maps opencode's reasons onto the OpenAI values", () => {
  assert.equal(toFinishReason("stop"), "stop")
  assert.equal(toFinishReason("length"), "length")
  assert.equal(toFinishReason("max-tokens"), "length")
  assert.equal(toFinishReason("content-filter"), "content_filter")
  assert.equal(toFinishReason("tool-calls"), "tool_calls")
  assert.equal(toFinishReason("error"), "stop")
  assert.equal(toFinishReason(undefined), "stop")
})
