/**
 * Core service: turns an OpenAI chat-completions request into an opencode
 * session run and converts the result back into an OpenAI response.
 */

import { config } from "./config.js"
import { buildResponseFormat, buildToolSchema, contentToText, flattenMessages, messagesToParts, structuredToJsonMessage, structuredToResponse, toFinishReason } from "./translator.js"

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
      throw new ServiceError(
        "No model specified and DEFAULT_MODEL is not configured",
        400,
        "model_required",
        undefined,
        "model",
      )
    }

    const entry = this.registry.resolve(wanted)
    if (!entry) {
      throw new ServiceError(
        `Model '${wanted}' is not available. Call GET /v1/models for the list of available models.`,
        404,
        "model_not_found",
        undefined,
        "model",
      )
    }
    return entry
  }

  /**
   * Runs a chat completion without streaming.
   *
   * The OpenAI `n` field asks for several answers. opencode returns one per
   * session, so the request is run that many times and the answers are merged
   * into one completion.
   */
  async complete(body, { signal } = {}) {
    const count = choiceCount(body.n)
    if (count === 1) return this.#completeOnce(body, { signal })

    const results = await Promise.all(
      Array.from({ length: count }, () => this.#completeOnce(body, { signal })),
    )
    const choices = results.flatMap((result, index) =>
      result.choices.map((choice) => ({ ...choice, index })),
    )
    const usage = results.reduce(
      (total, result) => ({
        prompt_tokens: total.prompt_tokens + result.usage.prompt_tokens,
        completion_tokens: total.completion_tokens + result.usage.completion_tokens,
        total_tokens: total.total_tokens + result.usage.total_tokens,
      }),
      { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    )

    return { ...results[0], choices, usage }
  }

  /** Runs a single chat completion. */
  async #completeOnce(body, { signal } = {}) {
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
          // Abort the request to opencode. The session itself is left alone:
          // aborting it makes opencode answer the next request with 499.
          abortController.abort()
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
        // The client left before the answer was ready. There is nobody left
        // to answer, so this is not an error anyone has to see.
        if (signal?.aborted) return undefined
        // opencode answers a failing provider with an HTTP error of its own.
        throw toServiceError(err)
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
      const responseFormat = buildResponseFormat(body.response_format)
      const hasTools = (body.tools ?? []).some((tool) => tool?.type === "function")
      const wantsJson = Boolean(responseFormat) && !hasTools
      const finishReason = toFinishReason(result?.info?.finish)

      if (structured !== undefined && structured !== null) {
        const { content, toolCalls } = structuredToResponse(structured)

        // A response_format request wants the raw JSON as the message body.
        if (wantsJson) {
          const json = structuredToJsonMessage(structured, responseFormat)
          return {
            id: completionId(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model.id,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: json || null },
                logprobs: null,
                finish_reason: "stop",
              },
            ],
            usage,
          }
        }

        // Tools and a response_format together: the model either calls a tool
        // or answers with JSON. Which one it did shows up in the answer, so
        // the finish reason has to follow it.
        const jsonAnswer = responseFormat ? structuredToJsonMessage(structured, responseFormat) : ""

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
                content: toolCalls.length ? content || null : jsonAnswer || content || null,
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
            finish_reason: toolCalls.length ? "tool_calls" : finishReason,
          },
        ],
        usage,
      }
    } finally {
      unsubscribe()
      // A client that disconnected leaves the session half-finished, so it has
      // to go. A completed session is left alone unless asked otherwise.
      if (config.deleteSessions || signal?.aborted) {
        await this.client.deleteSession(session.id)
        // The abort poisoned the opencode instance of this project: every
        // later request to it would answer with an empty 499. Disposing the
        // instance clears that.
        // See https://github.com/anomalyco/opencode/issues/58942
        if (signal?.aborted) await this.client.disposeInstance()
      }
    }
  }

  /**
   * Runs a chat completion with SSE streaming.
   *
   * The OpenAI `n` field asks for several answers. opencode answers once per
   * session, so the streams are run that many times and their chunks are
   * interleaved with distinct choice indexes.
   *
   * @param {any} body OpenAI request body
   * @param {(chunk: string) => void} emit writes a raw SSE chunk
   * @param {{signal?: AbortSignal}} options
   */
  async stream(body, emit, { signal } = {}) {
    const count = choiceCount(body.n)
    if (count === 1) return this.#streamOnce(body, emit, { signal, choiceIndex: 0 })

    // Each answer gets its own buffer. A chunk is written as soon as it
    // arrives, so the client sees the answers as they come in.
    const buffers = Array.from({ length: count }, () => [])

    const flush = () => {
      for (const buffer of buffers) {
        for (const chunk of buffer.splice(0)) emit(chunk)
      }
    }

    const runs = Array.from({ length: count }, (_, index) =>
      this.#streamOnce(
        body,
        (chunk) => {
          buffers[index].push(chunk)
          flush()
        },
        { signal, choiceIndex: index },
      ),
    )

    await Promise.all(runs)
  }

  /** Runs a single streaming chat completion. */
  async #streamOnce(body, emit, { signal, choiceIndex = 0 } = {}) {
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

    // The OpenAI streaming protocol opens with a chunk that only carries the
    // role, before any content arrives.
    send({ ...base, choices: [{ index: choiceIndex, delta: { role: "assistant" }, finish_reason: null }] })

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
    const responseFormat = buildResponseFormat(body.response_format)
    const wantsJson =
      Boolean(responseFormat) &&
      !(body.tools ?? []).some((tool) => tool?.type === "function")

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

    // The token counts arrive in their own event, which can land a moment
    // after the turn is over.
    let resolveUsage
    const usageReady = new Promise((resolve) => {
      resolveUsage = resolve
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
          send({ ...base, choices: [{ index: choiceIndex, delta: { reasoning_content: props.delta ?? "" }, finish_reason: null }] })
          return
        }
        // The user's own prompt is echoed back as a message part; it must not
        // be streamed as assistant content.
        if (messageRoles.get(props.messageID) === "user") return
        streamedText += props.delta ?? ""
        send({ ...base, choices: [{ index: choiceIndex, delta: { content: props.delta ?? "" }, finish_reason: null }] })
        return
      }

      if (type === "message.part.updated") {
        const part = props.part
        if (part?.id) partKinds.set(part.id, part.type)
        if (part?.type === "text" && part.text && isAssistantPart(part)) finalText = part.text

        if (part?.type === "step-finish") {
          const stepUsage = usageFrom(part.tokens)
          if (stepUsage.total_tokens > 0) usage = stepUsage
          finishReason = toFinishReason(part.reason)
        }

        if (part?.type === "tool" && part.tool === "StructuredOutput" && !structuredEmitted) {
          const state = part.state ?? {}
          if (state.status === "running" || state.status === "completed") {
            if (!state.input) return
            structuredEmitted = true

            // A response_format request wants the raw JSON as the content.
            if (wantsJson) {
              const json = structuredToJsonMessage(state.input, responseFormat)
              if (json) {
                send({ ...base, choices: [{ index: choiceIndex, delta: { content: json }, finish_reason: null }] })
              }
              resolveStructured?.(true)
              return
            }

            const { content, toolCalls } = structuredToResponse(state.input)
            if (content) {
              // With a response_format alongside the tools, the content is the
              // JSON answer.
              const json = wantsJson ? structuredToJsonMessage(state.input, responseFormat) : content
              if (json) {
                send({ ...base, choices: [{ index: choiceIndex, delta: { content: json }, finish_reason: null }] })
              }
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
            // A tool call and a JSON answer are different outcomes, so the
            // finish reason has to match what the stream actually carries.
            if (toolCalls.length) finishReason = "tool_calls"
            else if (wantsJson) finishReason = "stop"
            resolveStructured?.(true)
          }
        }
        return
      }

      if (type === "message.updated") {
        const info = props.info
        if (info?.role === "assistant" && info.tokens) {
          const messageUsage = usageFrom(info.tokens)
          if (messageUsage.total_tokens > 0) {
            usage = messageUsage
            resolveUsage?.()
          }
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
          finishReason = toFinishReason(info.finish)
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
        throw toServiceError(err)
      }

      const timeout = timeoutAfter(config.requestTimeout)
      await Promise.race([done, timeout])
      timeout.cancel?.()

      // The token counts can arrive just after the turn ended.
      if (!usage) {
        const usageTimeout = timeoutAfter(1000)
        await Promise.race([usageReady, usageTimeout])
        usageTimeout.cancel?.()
      }

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
        send({ ...base, choices: [{ index: choiceIndex, delta: { content: finalText }, finish_reason: null }] })
      }

      send({ ...base, choices: [{ index: choiceIndex, delta: {}, finish_reason: finishReason }] })
      // OpenAI only appends the usage chunk when the client asked for it.
      if (body.stream_options?.include_usage !== false) {
        send({ ...base, choices: [], usage: usage ?? usageFrom(null) })
      }
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
      // A client that disconnected leaves the session half-finished, so it has
      // to go. A completed session is left alone unless asked otherwise.
      if (config.deleteSessions || signal?.aborted) {
        await this.client.deleteSession(session.id)
        // The abort poisoned the opencode instance of this project: every
        // later request to it would answer with an empty 499. Disposing the
        // instance clears that.
        // See https://github.com/anomalyco/opencode/issues/58942
        if (signal?.aborted) await this.client.disposeInstance()
      }
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
    // a tool call carries the answer — but a response_format alongside the
    // tools still constrains the answer.
    const responseFormat = buildResponseFormat(body.response_format)
    const toolSchema = buildToolSchema(body.tools, body.tool_choice, responseFormat ?? {})
    if (toolSchema) {
      payload.format = { type: "json_schema", schema: toolSchema }
    } else if (responseFormat) {
      payload.format = { type: "json_schema", schema: responseFormat.schema }
    }

    return payload
  }
}

export class ServiceError extends Error {
  constructor(message, status = 500, code = "error", details, param = null) {
    super(message)
    this.name = "ServiceError"
    this.status = status
    this.code = code
    this.details = details
    /** The request field the error refers to, like the OpenAI error shape. */
    this.param = param
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
  if (/model not found|no such model|unknown model/i.test(message)) {
    return { status: 404, code: "model_not_found", message }
  }
  if (/context (length|window)|too long|maximum.*tokens/i.test(message)) {
    return { status: 413, code: "context_too_long", message }
  }
  return { status: 502, code: "provider_error", message }
}

/**
 * How many answers the client asked for.
 *
 * The OpenAI spec allows `n` between 1 and 128. Anything outside that is
 * treated as a single answer.
 */
function choiceCount(n) {
  const count = Number(n)
  if (!Number.isInteger(count) || count < 1) return 1
  return Math.min(count, 128)
}

/**
 * Turns an error from the opencode client into a well-shaped service error.
 *
 * opencode reports a failing provider as an HTTP error of its own, so the
 * status and the message have to be classified here instead of turning into
 * a generic 500.
 */
function toServiceError(err) {
  if (err instanceof ServiceError) return err

  const message = err?.message ?? "the opencode server returned an error"
  const failure = providerErrorStatus(message)

  // An empty 499 means opencode's instance of the project is broken. The
  // proxy disposes the instance after an abort, so this only happens when the
  // instance was poisoned some other way.
  if (err?.status === 499) {
    return new ServiceError(
      "The opencode instance of this project is in a broken state. Set DELETE_SESSIONS=true " +
        "or restart the proxy to clear it.",
      503,
      "opencode_instance_broken",
    )
  }

  // The message is more precise than the status: opencode reports a missing
  // model with a 500 even though it is a client error.
  if (failure.status !== 502) {
    return new ServiceError(message, failure.status, failure.code)
  }

  // Otherwise the HTTP status decides.
  if (err?.status === 404) return new ServiceError(message, 404, "model_not_found", undefined, "model")
  if (err?.status === 401 || err?.status === 403) {
    return new ServiceError(message, 401, "provider_unauthorized")
  }
  if (err?.status === 429) return new ServiceError(message, 429, "provider_rate_limited")
  if (err?.code === "timeout") return new ServiceError(message, 504, "timeout")
  if (err?.code === "unavailable") return new ServiceError(message, 503, "opencode_unavailable")

  // opencode hides the real cause behind a generic message and points at its
  // own log with a reference. Pass the reference on so the cause can be
  // found.
  const ref = err?.body?.data?.ref
  const detail = ref ? `${message} (opencode reference: ${ref})` : message
  return new ServiceError(detail, failure.status, failure.code)
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
