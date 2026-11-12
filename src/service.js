/**
 * Core service: turns an OpenAI chat-completions request into an opencode
 * session run and converts the result back into an OpenAI response.
 */

import { config } from "./config.js"
import { buildResponseFormat, buildToolSchema, contentToText, flattenMessages, messagesToParts, structuredToJsonMessage, structuredToResponse } from "./translator.js"

export class ProxyService {
  constructor({ client, registry, eventBus }) {
    this.client = client
    this.registry = registry
    this.eventBus = eventBus
    /** Reusable opencode agent for chat requests. */
    this.agent = config.defaultAgent
  }

  /** Resolves the requested model to an opencode provider/model pair. */
  resolveModel(requested) {
    const wanted = requested || config.defaultModel
    if (!wanted) {
      throw new ServiceError("No model specified and DEFAULT_MODEL is not configured", 400, "model_required")
    }

    const entry = this.registry.resolve(wanted)
    if (!entry) {
      throw new ServiceError(
        `Model '${wanted}' is not available. Call GET /v1/models for the list of available models.`,
        404,
        "model_not_found",
      )
    }
    return entry
  }

  /**
   * Runs a chat completion without streaming.
   */
  async complete(body, { signal } = {}) {
    const model = this.resolveModel(body.model)
    const session = await this.client.createSession(this.#sessionTitle(body))

    // opencode retries a failing provider internally (5 retries, 2s -> 30s
    // backoff, ~90s in total) and publishes a `retry` status for each
    // attempt. Abort the turn so the client learns about the failure at once.
    let providerFailure = null
    const abortController = new AbortController()
    const unsubscribe = this.eventBus.subscribe(session.id, (event) => {
      const props = event?.properties ?? {}

      if (event.type === "session.status" && props.status?.type === "retry") {
        const attempt = props.status.attempt ?? 1
        if (attempt >= (config.maxRetryAttempts ?? 1)) {
          providerFailure = providerErrorStatus(props.status.message ?? "the provider is retrying")
          abortController.abort()
          this.client.abortSession(session.id).catch(() => {})
        }
        return
      }

      if (event.type === "session.error") {
        providerFailure = providerErrorStatus(props.error)
        abortController.abort()
        return
      }

      const info = props.info
      if (info?.role === "assistant" && info.error) {
        providerFailure = providerErrorStatus(info.error)
        abortController.abort()
      }
    })

    try {
      const payload = this.#buildPayload(body, model)
      const combined = anySignal([signal, abortController.signal])

      let result
      try {
        result = await this.client.prompt(session.id, payload, { signal: combined })
      } catch (err) {
        // An abort caused by a detected provider failure must be reported as
        // the provider failure, not as a timeout.
        if (providerFailure) {
          throw new ServiceError(providerFailure.message, providerFailure.status, providerFailure.code)
        }
        throw err
      }

      if (providerFailure) {
        throw new ServiceError(providerFailure.message, providerFailure.status, providerFailure.code)
      }
      if (result?.info?.error) {
        const failure = providerErrorStatus(result.info.error)
        throw new ServiceError(failure.message, failure.status, failure.code)
      }

      const usage = usageFrom(result?.info?.tokens)
      const structured = result?.info?.structured
      const wantsJson = Boolean(buildResponseFormat(body.response_format))

      if (structured !== undefined && structured !== null) {
        // A response_format request wants the raw JSON as the message body.
        if (wantsJson && !body.tools?.length) {
          const content = structuredToJsonMessage(structured)
          return {
            id: completionId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: content || null },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage,
          }
        }

        const { content, toolCalls } = structuredToResponse(structured)
        return {
          id: completionId(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: model.id,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: content || null,
                ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
              },
              logprobs: null,
              finish_reason: toolCalls.length ? "tool_calls" : "stop",
            },
          ],
          usage,
        }
      }

      // No structured output requested: read the plain text parts.
      const text = collectText(result?.parts)
      const reasoning = collectReasoning(result?.parts)
      const { toolCalls } = extractToolParts(result?.parts)
      return {
        id: completionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: text || null,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
            },
            logprobs: null,
            finish_reason: toolCalls.length ? "tool_calls" : "stop",
          },
        ],
        usage,
      }
    } finally {
      unsubscribe()
      if (config.deleteSessions) await this.client.deleteSession(session.id)
    }
  }

  /**
   * Runs a chat completion with SSE streaming.
   * @param {any} body OpenAI request body
   * @param {(chunk: string) => void} emit writes a raw SSE chunk
   * @param {{signal?: AbortSignal}} options
   */
  async stream(body, emit, { signal } = {}) {
    const model = this.resolveModel(body.model)
    const session = await this.client.createSession(this.#sessionTitle(body))
    const completionID = completionId()
    const created = Math.floor(Date.now() / 1000)
    const base = { id: completionID, object: "chat.completion.chunk", created, model: model.id }

    let closed = false
    let providerFailure = null
    /** Aborts the opencode prompt when the provider fails. */
    const abortController = new AbortController()
    const send = (payload) => {
      if (closed) return
      emit(`data: ${JSON.stringify(payload)}\n\n`)
    }

    // Track streamed text so we can emit a final usage block.
    let streamedText = ""
    let finalText = ""
    let finishReason = "stop"
    let usage = null
    /** partID -> "text" | "reasoning" */
    const partKinds = new Map()
    /** messageID -> role */
    const messageRoles = new Map()
    let structuredEmitted = false
    /** The client asked for a JSON answer through `response_format`. */
    const wantsJson = Boolean(buildResponseFormat(body.response_format)) && !body.tools?.length

    // Structured output arrives as a `StructuredOutput` tool part, which
    // opencode publishes *after* the prompt call resolves. Resolve this
    // deferred once the payload shows up.
    let resolveStructured
    const structuredReady = new Promise((resolve) => {
      resolveStructured = resolve
    })

    // The turn ends when the assistant message is finished.
    let resolveDone
    const done = new Promise((resolve) => {
      resolveDone = resolve
    })

    /** True while we are handling an assistant message (not the user's echo). */
    const isAssistantPart = (part) => {
      const role = messageRoles.get(part?.messageID)
      return role === undefined || role === "assistant"
    }

    const unsubscribe = this.eventBus.subscribe(session.id, (event) => {
      const type = event.type
      const props = event.properties ?? {}

      if (type === "message.updated") {
        const info = props.info
        if (info?.id && info?.role) messageRoles.set(info.id, info.role)
      }

      // opencode retries a failing provider internally (5 retries, 2s -> 30s
      // backoff, ~90s in total) and publishes a `retry` status for each
      // attempt. Abort the turn so the client learns about the failure at once.
      if (type === "session.status" && props.status?.type === "retry") {
        const attempt = props.status.attempt ?? 1
        if (attempt >= (config.maxRetryAttempts ?? 1)) {
          providerFailure = providerErrorStatus(props.status.message ?? "the provider is retrying")
          abortController.abort()
          resolveDone?.()
          this.client.abortSession(session.id).catch(() => {})
        }
        return
      }

      // opencode publishes the final error here once the retries are exhausted.
      if (type === "session.error") {
        providerFailure = providerErrorStatus(props.error)
        abortController.abort()
        resolveDone?.()
        return
      }

      if (type === "message.part.delta" && props.field === "text") {
        const kind = partKinds.get(props.partID)
        // Reasoning deltas are surfaced separately so they never pollute the
        // assistant message content.
        if (kind === "reasoning") {
          send({ ...base, choices: [{ index: 0, delta: { reasoning_content: props.delta ?? "" }, finish_reason: null }] })
          return
        }
        // The user's own prompt is echoed back as a message part; it must not
        // be streamed as assistant content.
        if (messageRoles.get(props.messageID) === "user") return
        streamedText += props.delta ?? ""
        send({ ...base, choices: [{ index: 0, delta: { content: props.delta ?? "" }, finish_reason: null }] })
        return
      }

      if (type === "message.part.updated") {
        const part = props.part
        if (part?.id) partKinds.set(part.id, part.type)
        if (part?.type === "text" && part.text && isAssistantPart(part)) finalText = part.text

        if (part?.type === "step-finish") {
          const stepUsage = usageFrom(part.tokens)
          if (stepUsage.total_tokens > 0) usage = stepUsage
          finishReason = part.reason === "tool-calls" ? "tool_calls" : (part.reason ?? "stop")
        }

        if (part?.type === "tool" && part.tool === "StructuredOutput" && !structuredEmitted) {
          const state = part.state ?? {}
          if (state.status === "running" || state.status === "completed") {
            if (!state.input) return
            structuredEmitted = true

            // A response_format request wants the raw JSON as the content.
            if (wantsJson && !body.tools?.length) {
              const json = structuredToJsonMessage(state.input)
              if (json) {
                send({ ...base, choices: [{ index: 0, delta: { content: json }, finish_reason: null }] })
              }
              resolveStructured?.(true)
              return
            }

            const { content, toolCalls } = structuredToResponse(state.input)
            if (content) {
              send({ ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] })
            }
            for (const call of toolCalls) {
              send({
                ...base,
                choices: [
                  {
                    index: 0,
                    delta: { tool_calls: [{ index: 0, id: call.id, type: "function", function: call.function }] },
                    finish_reason: null,
                  },
                ],
              })
            }
            if (toolCalls.length) finishReason = "tool_calls"
            resolveStructured?.(true)
          }
        }
        return
      }

      if (type === "message.updated") {
        const info = props.info
        if (info?.role === "assistant" && info.tokens) {
          const messageUsage = usageFrom(info.tokens)
          if (messageUsage.total_tokens > 0) usage = messageUsage
        }
        if (info?.role === "assistant" && info.error) {
          // opencode keeps retrying the provider internally. Abort the request
          // so the client gets the error immediately instead of waiting for
          // every retry to expire.
          const failure = providerErrorStatus(info.error)
          providerFailure = failure
          abortController?.abort()
          resolveDone?.()
          return
        }
        // The assistant message carries `finish` once the turn is over.
        if (info?.role === "assistant" && info?.finish) {
          resolveDone?.()
        }
      }
    })

    try {
      const payload = this.#buildPayload(body, model)
      const combined = anySignal([signal, abortController.signal])

      // Fire the prompt without waiting for the reply: the answer arrives on
      // the event stream, and a failing provider is reported there too.
      try {
        await this.client.promptAsync(session.id, payload, { signal: combined })
      } catch (err) {
        if (providerFailure) {
          throw new ServiceError(providerFailure.message, providerFailure.status, providerFailure.code)
        }
        throw err
      }

      const timeout = timeoutAfter(config.requestTimeout)
      await Promise.race([done, timeout])
      timeout.cancel?.()

      if (providerFailure) {
        throw new ServiceError(providerFailure.message, providerFailure.status, providerFailure.code)
      }

      // Structured output may not have arrived yet — give it a moment.
      if (payload.format && !structuredEmitted) {
        const timeout = timeoutAfter(3000)
        await Promise.race([structuredReady, timeout])
        timeout.cancel?.()
      }

      // If nothing was streamed (e.g. a short answer that arrived before the
      // subscription was live), fall back to the text the events reported.
      if (!streamedText && !structuredEmitted && finalText) {
        send({ ...base, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] })
      }

      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
      send({ ...base, choices: [], usage: usage ?? usageFrom(null) })
      emit("data: [DONE]\n\n")
    } catch (err) {
      if (providerFailure) {
        const failure = new ServiceError(providerFailure.message, providerFailure.status, providerFailure.code)
        emit(`data: ${JSON.stringify(errorChunk(failure))}\n\n`)
        emit("data: [DONE]\n\n")
        return
      }
      if (err instanceof ServiceError) {
        emit(`data: ${JSON.stringify(errorChunk(err))}\n\n`)
        emit("data: [DONE]\n\n")
      } else {
        throw err
      }
    } finally {
      closed = true
      unsubscribe()
      if (config.deleteSessions) await this.client.deleteSession(session.id)
    }
  }

  /**
   * A short, non-default title for the opencode session.
   *
   * opencode only generates a session title when the title is still the
   * auto-generated default, and that generation is a full extra LLM call. A
   * title derived from the first user message skips it entirely.
   */
  #sessionTitle(body) {
    const first = (body.messages ?? []).find((m) => m?.role === "user")
    const text = contentToText(first?.content).trim()
    if (!text) return "opencode proxy request"
    return text.length > 60 ? `${text.slice(0, 57)}...` : text
  }

  #buildPayload(body, model) {
    const payload = {
      model: { providerID: model.providerID, modelID: model.modelID },
      agent: this.agent,
      parts: messagesToParts(body.messages),
    }

    if (model.variant) payload.variant = model.variant

    const system = extractSystemPrompt(body.messages)
    if (system) payload.system = system

    // Function calling and response_format both use opencode's structured
    // output, so only one schema can be active at a time. Tools win, because
    // a tool call carries the answer.
    const toolSchema = buildToolSchema(body.tools, body.tool_choice)
    if (toolSchema) {
      payload.format = { type: "json_schema", schema: toolSchema }
    } else {
      const responseFormat = buildResponseFormat(body.response_format)
      if (responseFormat) payload.format = { type: "json_schema", schema: responseFormat.schema }
    }

    return payload
  }
}

export class ServiceError extends Error {
  constructor(message, status = 500, code = "error", details) {
    super(message)
    this.name = "ServiceError"
    this.status = status
    this.code = code
    this.details = details
  }
}

/**
 * A timer that does not keep the process alive.
 *
 * `Promise.race` does not cancel the losing promise, so a plain
 * `setTimeout` would keep the event loop busy long after the race is over.
 */
function timeoutAfter(ms) {
  let timer
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
  promise.cancel = () => clearTimeout(timer)
  return promise
}

/** Combines several abort signals into one. */function anySignal(signals) {
  const list = signals.filter((signal) => signal && typeof signal.addEventListener === "function")
  if (list.length === 0) return undefined
  if (list.length === 1) return list[0]

  const controller = new AbortController()
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true })
  }
  return controller.signal
}

function extractSystemPrompt(messages) {
  const parts = []
  for (const message of messages ?? []) {
    if (message?.role !== "system" && message?.role !== "developer") continue
    const text = typeof message.content === "string" ? message.content : flattenMessages([message])
    if (text) parts.push(text)
  }
  return parts.join("\n\n")
}

function collectText(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text ?? "")
    .join("")
}

function collectReasoning(parts) {
  return (parts ?? [])
    .filter((part) => part?.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("")
}

function extractToolParts(parts) {
  const toolCalls = []
  for (const part of parts ?? []) {
    if (part?.type !== "tool") continue
    const state = part.state ?? {}
    const input = state.input ?? {}
    if (input.tool_calls) {
      const { toolCalls: converted } = structuredToResponse(input)
      toolCalls.push(...converted)
    }
  }
  return { toolCalls }
}

function usageFrom(tokens) {
  if (!tokens) {
    return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  }
  const prompt = (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
  const completion = tokens.output ?? 0
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(tokens.reasoning ? { completion_tokens_details: { reasoning_tokens: tokens.reasoning } } : {}),
  }
}

function describeOpencodeError(error) {
  if (!error) return "unknown opencode error"
  if (typeof error === "string") return error
  return error.data?.message ?? error.name ?? error.message ?? JSON.stringify(error)
}

/**
 * opencode reports quota problems in a few different shapes. Detect them so
 * the client gets an actionable message instead of a generic 502.
 */
function providerErrorStatus(error) {
  const message = describeOpencodeError(error)
  if (
    /free usage|usage limit|usage exceeded|rate limit|quota|too many requests|free_tier|free limit/i.test(
      message,
    )
  ) {
    return { status: 429, code: "provider_rate_limited", message }
  }
  if (/not connected|unauthorized|invalid.*key|authentication|\b401\b/i.test(message)) {
    return { status: 401, code: "provider_unauthorized", message }
  }
  if (/context (length|window)|too long|maximum.*tokens/i.test(message)) {
    return { status: 413, code: "context_too_long", message }
  }
  return { status: 502, code: "provider_error", message }
}

function errorChunk(err) {
  return {
    error: {
      message: err.message,
      type: "proxy_error",
      code: err.code,
    },
  }
}

function completionId() {
  return `chatcmpl-${Math.random().toString(36).slice(2, 12)}${Date.now().toString(36)}`
}
