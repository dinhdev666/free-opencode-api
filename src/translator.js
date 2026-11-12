/**
 * Translation between the OpenAI chat-completions protocol and the opencode
 * session API.
 *
 * Two things need translating:
 *
 *  1. **Messages** — opencode only accepts flat `text` / `file` parts inside a
 *     single user turn, so an OpenAI message list is flattened into one
 *     role-tagged transcript.
 *
 *  2. **Tools** — opencode has no per-request custom-tool facility, but it does
 *     support structured output with a client-supplied JSON Schema. We use that
 *     to emulate OpenAI function calling: the schema describes the callable
 *     functions, and the model's structured answer is converted back into
 *     OpenAI `tool_calls`.
 */

const ROLE_LABELS = {
  system: "System",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  developer: "Developer",
  function: "Function",
}

/**
 * Flattens OpenAI messages into a single transcript text.
 * @param {any[]} messages
 */
export function flattenMessages(messages) {
  const chunks = []

  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue
    const role = message.role ?? "user"
    const label = ROLE_LABELS[role] ?? role

    if (role === "tool" || role === "function") {
      const name = message.name ?? message.tool_call_id ?? "tool"
      chunks.push(`[${label}: ${name}]\n${contentToText(message.content)}`)
      continue
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls
        .map((call) => {
          const fn = call.function ?? {}
          return `- ${fn.name}(${fn.arguments ?? "{}"})`
        })
        .join("\n")
      chunks.push(`[${label}]\n${contentToText(message.content)}\n${calls}`)
      continue
    }

    chunks.push(`[${label}]\n${contentToText(message.content)}`)
  }

  return chunks.join("\n\n")
}

/** Extracts plain text from an OpenAI content value. */
export function contentToText(content) {
  if (content === undefined || content === null) return ""
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return String(content)

  return content
    .map((part) => {
      if (!part) return ""
      if (typeof part === "string") return part
      if (part.type === "text" || part.type === "input_text") return part.text ?? ""
      if (part.type === "image_url") {
        const url = part.image_url?.url ?? ""
        return url ? `[image: ${url}]` : "[image]"
      }
      if (part.type === "input_image") {
        const url = part.image_url ?? part.url ?? ""
        return url ? `[image: ${url}]` : "[image]"
      }
      return ""
    })
    .filter(Boolean)
    .join("\n")
}

/**
 * Splits OpenAI message content into opencode parts.
 * Images become `file` parts so multimodal models can consume them.
 */
export function messagesToParts(messages) {
  const parts = []

  // Map the tool call id to the function name, so a tool result can name the
  // function it belongs to even when the client did not send `name`.
  const callNames = new Map()
  for (const message of messages ?? []) {
    for (const call of message?.tool_calls ?? []) {
      if (call?.id && call?.function?.name) callNames.set(call.id, call.function.name)
    }
  }

  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue
    const role = message.role ?? "user"
    if (role === "tool" || role === "function") {
      const id = message.tool_call_id ?? message.id
      const name = message.name ?? (id ? callNames.get(id) : undefined) ?? "tool"
      parts.push({ type: "text", text: `[Tool result: ${name}]\n${contentToText(message.content)}` })
      continue
    }

    if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const calls = message.tool_calls
        .map((call) => {
          const fn = call.function ?? {}
          return `[Tool call: ${fn.name}]\n${fn.arguments ?? "{}"}`
        })
        .join("\n")
      parts.push({ type: "text", text: `[Assistant tool calls]\n${calls}` })
      if (contentToText(message.content)) {
        parts.push({ type: "text", text: `[Assistant]\n${contentToText(message.content)}` })
      }
      continue
    }

    const content = message.content
    if (typeof content === "string") {
      if (content) parts.push({ type: "text", text: `[${ROLE_LABELS[role] ?? role}]\n${content}` })
      continue
    }

    if (Array.isArray(content)) {
      const text = contentToText(content)
      if (text) parts.push({ type: "text", text: `[${ROLE_LABELS[role] ?? role}]\n${text}` })
      for (const part of content) {
        if (!part || typeof part !== "object") continue
        const url = part.type === "image_url" ? part.image_url?.url : part.type === "input_image" ? part.image_url ?? part.url : undefined
        if (!url) continue
        parts.push({ type: "file", mime: mimeFromUrl(url), url })
      }
      continue
    }

    const text = contentToText(content)
    if (text) parts.push({ type: "text", text: `[${ROLE_LABELS[role] ?? role}]\n${text}` })
  }

  return parts
}

function mimeFromUrl(url) {
  if (typeof url !== "string") return "image/png"
  if (url.startsWith("data:")) {
    const match = /^data:([^;,]+)/.exec(url)
    return match ? match[1] : "image/png"
  }
  if (/\.jpe?g(\?|$)/i.test(url)) return "image/jpeg"
  if (/\.gif(\?|$)/i.test(url)) return "image/gif"
  if (/\.webp(\?|$)/i.test(url)) return "image/webp"
  if (/\.pdf(\?|$)/i.test(url)) return "application/pdf"
  return "image/png"
}

/**
 * Builds the JSON Schema used to emulate OpenAI function calling.
 *
 * The schema has two possible shapes:
 *  - `{ content, tool_calls }` — the model may answer directly or call tools.
 *  - `{ content }` — tool calling is disabled (tool_choice "none").
 *
 * @param {any[]} tools OpenAI tool definitions
 * @param {any} toolChoice
 */
export function buildToolSchema(tools, toolChoice) {
  const list = (tools ?? []).filter((tool) => tool && tool.type === "function" && tool.function)
  if (!list.length) return undefined

  const forced = forcedFunctionName(toolChoice)
  const disabled = toolChoice === "none"
  const required = toolChoice === "required"

  const variants = list
    .filter((tool) => !forced || tool.function.name === forced)
    .map((tool) => ({
      type: "object",
      properties: {
        name: { type: "string", const: tool.function.name },
        arguments: normalizeSchema(tool.function.parameters),
      },
      required: ["name", "arguments"],
      additionalProperties: false,
    }))

  const schema = {
    type: "object",
    properties: {
      content: { type: ["string", "null"] },
    },
    required: ["content"],
    additionalProperties: false,
  }

  if (!disabled && variants.length) {
    schema.properties.tool_calls = { type: "array", items: { anyOf: variants } }
  }

  // `tool_choice: "required"` means the model has to call a tool. The
  // schema makes `tool_calls` mandatory and forbids a plain answer.
  if (required && variants.length) {
    schema.required = ["tool_calls"]
    schema.properties.content = { type: "null" }
    delete schema.properties.tool_calls.minItems
    schema.properties.tool_calls.minItems = 1
  }

  return schema
}

/**
 * Builds the opencode `format` for an OpenAI `response_format`.
 *
 * OpenAI offers two shapes:
 *  - `{ type: "json_object" }` — the answer must be valid JSON.
 *  - `{ type: "json_schema", json_schema: { schema } }` — the answer must
 *    match a schema.
 *
 * opencode implements both through the same structured-output mechanism: the
 * answer is captured in `info.structured`.
 *
 * @param {any} responseFormat
 * @returns {{schema: object, unwrapContent: boolean}|undefined}
 */
export function buildResponseFormat(responseFormat) {
  if (!responseFormat || typeof responseFormat !== "object") return undefined

  if (responseFormat.type === "json_schema") {
    const schema = responseFormat.json_schema?.schema
    if (!schema || typeof schema !== "object") return undefined
    return { schema: normalizeSchema(schema), unwrapContent: false }
  }

  if (responseFormat.type === "json_object") {
    // JSON mode: any JSON value is acceptable. The answer is wrapped in a
    // `content` field, which is unwrapped again on the way out.
    return {
      schema: {
        type: "object",
        properties: { content: { type: ["string", "null"] } },
        required: ["content"],
        additionalProperties: false,
      },
      unwrapContent: true,
    }
  }

  return undefined
}

/**
 * Converts the structured answer into the message body of a response_format
 * request. The answer is the raw JSON the model produced.
 *
 * @param {unknown} structured
 * @param {{unwrapContent?: boolean}} options
 */
export function structuredToJsonMessage(structured, { unwrapContent = false } = {}) {
  if (structured === undefined || structured === null) return ""
  if (typeof structured === "string") return structured

  // A json_object answer is wrapped in `{ content }`; the payload is the
  // inner value. A json_schema answer is the object itself.
  if (unwrapContent && structured.content !== undefined) {
    return structured.content === null ? "" : String(structured.content)
  }
  return JSON.stringify(structured)
}

function forcedFunctionName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return undefined
  if (toolChoice.type === "function" && toolChoice.function?.name) return toolChoice.function.name
  return undefined
}

/**
 * Maps an opencode stop reason onto an OpenAI `finish_reason`.
 *
 * opencode reports the AI SDK's reasons: `stop`, `length`,
 * `content-filter`, `tool-calls`, `error`, `unknown`. OpenAI uses
 * `stop`, `length`, `content_filter`, `tool_calls`, `function_call`.
 *
 * @param {string|undefined} reason
 * @returns {"stop"|"length"|"content_filter"|"tool_calls"}
 */
export function toFinishReason(reason) {
  switch (reason) {
    case "length":
    case "max-tokens":
      return "length"
    case "content-filter":
    case "content_filter":
      return "content_filter"
    case "tool-calls":
    case "tool_calls":
      return "tool_calls"
    default:
      // `stop`, `error`, `unknown` and anything else end the turn normally.
      return "stop"
  }
}

/**
 * JSON Schema for tool arguments. OpenAI clients often send a schema without
 * `type: "object"`; opencode's structured output wants a well-formed object.
 */
function normalizeSchema(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return { type: "object", properties: {}, additionalProperties: true }
  }
  const schema = { ...parameters }
  if (!schema.type) schema.type = "object"
  if (schema.type === "object" && !schema.properties) schema.properties = {}
  if (!schema.required) schema.required = []
  return schema
}

/**
 * Converts a structured answer produced by opencode into OpenAI tool calls.
 * @returns {{content: string, toolCalls: any[]}}
 */
export function structuredToResponse(structured) {
  if (!structured || typeof structured !== "object") {
    return { content: typeof structured === "string" ? structured : "", toolCalls: [] }
  }

  const content = typeof structured.content === "string" ? structured.content : ""
  const toolCalls = []

  for (const [index, call] of (structured.tool_calls ?? []).entries()) {
    if (!call || typeof call !== "object") continue
    const name = call.name ?? call.function?.name
    if (!name) continue
    const args = call.arguments ?? call.function?.arguments ?? {}
    toolCalls.push({
      id: call.id ?? `call_${index}_${randomId()}`,
      type: "function",
      function: {
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    })
  }

  return { content, toolCalls }
}

function randomId() {
  return Math.random().toString(36).slice(2, 12)
}
