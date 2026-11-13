/**
 * Fastify application exposing an OpenAI-compatible REST API on top of the
 * locally installed opencode CLI.
 */

import Fastify from "fastify"
import cors from "@fastify/cors"

import { config } from "./config.js"
import { ModelRegistry } from "./model-registry.js"
import { OpencodeClient } from "./opencode-client.js"
import { EventBus } from "./event-bus.js"
import { ProxyService, ServiceError } from "./service.js"

export function buildServer({ client, registry, eventBus } = {}) {
  const ocClient = client ?? new OpencodeClient()
  const modelRegistry = registry ?? new ModelRegistry()
  const bus = eventBus ?? new EventBus(ocClient)
  const service = new ProxyService({ client: ocClient, registry: modelRegistry, eventBus: bus })

  const app = Fastify({
    // The logger is off by default: the proxy writes no log files and keeps
    // stdout quiet, which is what a container or a small VPS wants.
    logger: config.logLevel !== "silent" ? { level: config.logLevel } : false,
    // A JSON body costs far more memory than its size: the raw bytes, the
    // parsed object and the copies the proxy makes of it. A 19 MB body
    // measured 340 MB of resident memory, so the limit is well below what
    // any real chat request needs.
    bodyLimit: config.maxBodySize * 1024 * 1024,
  })

  app.decorate("opencode", { client: ocClient, registry: modelRegistry, eventBus: bus, service })

  app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  })

  // Keep-alive sockets would otherwise keep the process alive on shutdown.
  app.addHook("onClose", async () => {
    app.server.closeAllConnections?.()
  })

  /** Optional bearer-token check. */
  app.addHook("onRequest", async (request, reply) => {
    if (!config.apiKey) return
    if (request.url === "/health" || request.url === "/v1/health") return

    const header = request.headers.authorization ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : request.headers["x-api-key"]
    if (token !== config.apiKey) {
      return reply.code(401).send({
        error: { message: "Invalid API key", type: "invalid_request_error", param: null, code: "invalid_api_key" },
      })
    }
  })

  /**
   * Builds an AbortSignal that fires when the client disconnects.
   *
   * The request stream cannot be used: its `close` event fires as soon as the
   * body was received, long before the answer is sent. The response can: its
   * `close` event fires when the connection goes away, and `writableEnded`
   * tells a disconnect from a response that was written successfully.
   *
   * The listener is removed once the response is done, so a keep-alive
   * connection does not leave a stale handler behind that would abort the
   * next request.
   */
  function requestSignal(request, reply) {
    const controller = new AbortController()
    const response = reply.raw

    const abort = () => {
      if (!controller.signal.aborted) controller.abort()
    }

    const onClose = () => {
      // The connection went away before the answer was written.
      if (!response.writableEnded) abort()
    }

    request.raw.on("aborted", abort)
    response.on("close", onClose)

    // The listener belongs to this request alone. A keep-alive connection
    // reuses the socket, so a listener that stayed behind could abort a later
    // request.
    const detach = () => response.off("close", onClose)
    response.on("finish", detach)
    response.on("close", detach)

    return controller.signal
  }

  // The signal has to exist before the route runs: a client can disconnect
  // while the request is still being read, and the route has to see that.
  app.decorateRequest("clientSignal", null)
  app.addHook("onRequest", async (request, reply) => {
    request.clientSignal = requestSignal(request, reply)
  })

  // Fastify drops the connection when the body is over the limit, so the
  // client never sees the error. Checking the announced length up front
  // answers with a proper 413 instead.
  app.addHook("preParsing", async (request, reply, payload) => {
    const length = Number(request.headers["content-length"])
    if (Number.isFinite(length) && length > config.maxBodySize * 1024 * 1024) {
      reply.code(413).send({
        error: {
          message: `The request body is larger than the ${config.maxBodySize} MB limit.`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      })
      return payload
    }
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ServiceError) {
      return reply.code(error.status).send({
        error: { message: error.message, type: "proxy_error", param: error.param ?? null, code: error.code },
      })
    }
    // An opencode request that ran out of time.
    if (error?.code === "timeout") {
      return reply.code(504).send({
        error: {
          message:
            error.message ??
            "The upstream provider did not answer in time. opencode retries slow providers automatically; raise REQUEST_TIMEOUT or try another model.",
          type: "proxy_error",
          param: null,
          code: "timeout",
        },
      })
    }
    if (error?.code === "unavailable") {
      return reply.code(503).send({
        error: { message: error.message, type: "proxy_error", param: null, code: "opencode_unavailable" },
      })
    }
    if (error.validation) {
      return reply.code(400).send({
        error: { message: error.message, type: "invalid_request_error", param: null, code: "invalid_request" },
      })
    }

    // A body the proxy could not read is the client's mistake, not a proxy
    // failure: Fastify reports a broken JSON body and a missing content type
    // with their own status codes.
    if (error.code === "FST_ERR_CTP_BODY_TOO_LARGE") {
      return reply.code(413).send({
        error: {
          message: `The request body is larger than the ${config.maxBodySize} MB limit.`,
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      })
    }
    if (error.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") {
      return reply.code(415).send({
        error: {
          message: "The request body must be sent as application/json.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      })
    }
    if (error.code === "FST_ERR_CTP_EMPTY_JSON_BODY" || error.code === "FST_ERR_CTP_INVALID_JSON_BODY") {
      return reply.code(400).send({
        error: {
          message: error.message ?? "The request body is not valid JSON.",
          type: "invalid_request_error",
          param: null,
          code: "invalid_request",
        },
      })
    }

    request.log?.error({ err: error }, "request failed")
    return reply.code(error.statusCode ?? 500).send({
      error: { message: error.message ?? "internal error", type: "proxy_error", param: null, code: "internal_error" },
    })
  })

  // ---------------------------------------------------------------- health

  const healthHandler = async () => {
    let opencode = { healthy: false }
    try {
      opencode = await ocClient.health()
    } catch (err) {
      opencode = { healthy: false, error: err.message }
    }
    return {
      status: opencode.healthy ? "ok" : "degraded",
      opencode,
      models: modelRegistry.size,
    }
  }

  app.get("/health", async () => healthHandler())
  app.get("/v1/health", async () => healthHandler())

  // ---------------------------------------------------------------- models

  app.get("/v1/models", async (request, reply) => {
    await ensureModels()
    return reply.send(modelRegistry.list(config.owner))
  })

  // A model id contains a slash (`provider/model`), so the route has to accept
  // the rest of the path.
  app.get("/v1/models/*", async (request, reply) => {
    await ensureModels()
    const id = decodeURIComponent(request.params["*"] ?? "")
    const entry = modelRegistry.resolve(id)
    if (!entry) {
      return reply.code(404).send({
        error: { message: `Model '${id}' not found`, type: "invalid_request_error", param: "model", code: "model_not_found" },
      })
    }
    return reply.send({
      id: entry.id,
      object: "model",
      created: Math.floor(modelRegistry.loadedAt / 1000),
      owned_by: entry.ownedBy,
    })
  })

  // ------------------------------------------------------- chat completions

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body ?? {}
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return reply.code(400).send({
        error: { message: "'messages' is required and must be a non-empty array", type: "invalid_request_error", param: "messages", code: "invalid_request" },
      })
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return reply.code(400).send({
        error: { message: "'model' must be a string", type: "invalid_request_error", param: "model", code: "invalid_request" },
      })
    }

    await ensureModels()

    if (body.stream) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      reply.raw.write(": ping\n\n")

      const abort = new AbortController()
      request.raw.on("close", () => abort.abort())
      try {
        await service.stream(body, (chunk) => reply.raw.write(chunk), { signal: abort.signal })
      } catch (err) {
        app.log.error({ err }, "stream failed")
        reply.raw.write(
          `data: ${JSON.stringify({ error: { message: err.message, type: "proxy_error", param: err.param ?? null, code: err.code ?? "internal_error" } })}\n\n`,
        )
        reply.raw.write("data: [DONE]\n\n")
      } finally {
        reply.raw.end()
      }
      return reply
    }

    const result = await service.complete(body, { signal: request.clientSignal })
    // The client disconnected before the answer was ready.
    if (!result) return reply
    return reply.send(result)
  })

  // ------------------------------------------------------------ completions

  app.post("/v1/completions", async (request, reply) => {
    const body = request.body ?? {}
    const prompt = body.prompt
    if (prompt === undefined || prompt === null) {
      return reply.code(400).send({
        error: { message: "'prompt' is required", type: "invalid_request_error", param: "prompt", code: "invalid_request" },
      })
    }
    if (body.model !== undefined && typeof body.model !== "string") {
      return reply.code(400).send({
        error: { message: "'model' must be a string", type: "invalid_request_error", param: "model", code: "invalid_request" },
      })
    }

    const text = Array.isArray(prompt) ? prompt.join("\n") : String(prompt)
    const chatBody = {
      model: body.model,
      messages: [{ role: "user", content: text }],
      ...(body.stop ? { stop: body.stop } : {}),
      ...(body.n !== undefined ? { n: body.n } : {}),
      ...(body.stream_options ? { stream_options: body.stream_options } : {}),
    }

    await ensureModels()

    if (body.stream) {
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      })
      reply.raw.write(": ping\n\n")

      const abort = new AbortController()
      request.raw.on("close", () => abort.abort())

      const created = Math.floor(Date.now() / 1000)
      const id = `cmpl-${Math.random().toString(36).slice(2, 12)}`
      let model = body.model ?? ""

      try {
        await service.stream(chatBody, (chunk) => {
          // The chat-completions chunk format is translated into the legacy
          // text-completion chunk format.
          const match = /^data: (\{.*\})$/.exec(chunk.trim())
          if (!match) {
            if (chunk.trim() === "data: [DONE]") reply.raw.write("data: [DONE]\n\n")
            return
          }
          let payload
          try {
            payload = JSON.parse(match[1])
          } catch {
            return
          }
          if (payload.model) model = payload.model

          // The usage chunk carries no choices, so it has to be handled before
          // the choice is looked at.
          if (!payload.choices?.length) {
            if (payload.usage) {
              reply.raw.write(
                `data: ${JSON.stringify({
                  id,
                  object: "text_completion",
                  created,
                  model,
                  choices: [],
                  usage: payload.usage,
                })}\n\n`,
              )
            }
            return
          }

          const choice = payload.choices[0]
          const text = choice.delta?.content ?? ""
          reply.raw.write(
            `data: ${JSON.stringify({
              id,
              object: "text_completion",
              created,
              model,
              choices: [{ index: 0, text, logprobs: null, finish_reason: choice.finish_reason ?? null }],
            })}\n\n`,
          )
        }, { signal: abort.signal })
      } catch (err) {
        app.log.error({ err }, "stream failed")
        reply.raw.write(
          `data: ${JSON.stringify({ error: { message: err.message, type: "proxy_error", param: err.param ?? null, code: err.code ?? "internal_error" } })}\n\n`,
        )
        reply.raw.write("data: [DONE]\n\n")
      } finally {
        reply.raw.end()
      }
      return reply
    }

    const result = await service.complete(chatBody, { signal: request.clientSignal })
    return reply.send({
      id: result.id,
      object: "text_completion",
      created: result.created,
      model: result.model,
      choices: result.choices.map((choice) => ({
        index: choice.index,
        text: choice.message.content ?? "",
        logprobs: null,
        finish_reason: choice.finish_reason,
      })),
      usage: result.usage,
    })
  })

  /**
   * Refreshes the model catalogue from opencode when it is stale.
   *
   * The refresh is shared: concurrent requests wait for the one in flight
   * instead of each pulling the ~7 MB catalogue on its own.
   */
  let refresh = null
  async function ensureModels() {
    if (!modelRegistry.isStale() && modelRegistry.size) return
    if (refresh) return refresh

    refresh = (async () => {
      try {
        const payload = await ocClient.providers()
        modelRegistry.update(payload)
      } catch (err) {
        if (!modelRegistry.size) throw err
        app.log.warn({ err }, "could not refresh opencode model catalogue")
      }
    })().finally(() => {
      refresh = null
    })

    return refresh
  }

  // An unknown route answers like the OpenAI API does, so a client that
  // probes an endpoint the proxy does not implement still gets a usable error.
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        message: `Unknown endpoint: ${request.method} ${request.url}`,
        type: "invalid_request_error",
        param: null,
        code: "unknown_endpoint",
      },
    })
  })

  return app
}
