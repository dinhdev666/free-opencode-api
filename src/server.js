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
    bodyLimit: 32 * 1024 * 1024,
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

  /** Builds an AbortSignal that fires when the client disconnects. */
  function requestSignal(request) {
    const controller = new AbortController()
    request.raw.on("close", () => {
      if (!request.raw.readableEnded) controller.abort()
    })
    return controller.signal
  }

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

  app.get("/v1/models/:id", async (request, reply) => {
    await ensureModels()
    const entry = modelRegistry.resolve(request.params.id)
    if (!entry) {
      return reply.code(404).send({
        error: { message: `Model '${request.params.id}' not found`, type: "invalid_request_error", param: "model", code: "model_not_found" },
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

    const result = await service.complete(body, { signal: requestSignal(request) })
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

    const text = Array.isArray(prompt) ? prompt.join("\n") : String(prompt)
    const chatBody = {
      model: body.model,
      messages: [{ role: "user", content: text }],
      ...(body.stop ? { stop: body.stop } : {}),
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
          const choice = payload.choices?.[0]
          if (!choice) return
          const text = choice.delta?.content ?? ""
          reply.raw.write(
            `data: ${JSON.stringify({
              id,
              object: "text_completion",
              created,
              model,
              choices: [{ index: 0, text, logprobs: null, finish_reason: choice.finish_reason ?? null }],
              ...(payload.usage ? { usage: payload.usage } : {}),
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

    const result = await service.complete(chatBody, { signal: requestSignal(request) })
    const choice = result.choices[0]
    return reply.send({
      id: result.id,
      object: "text_completion",
      created: result.created,
      model: result.model,
      choices: [
        {
          index: 0,
          text: choice.message.content ?? "",
          logprobs: null,
          finish_reason: choice.finish_reason,
        },
      ],
      usage: result.usage,
    })
  })

  /** Refreshes the model catalogue from opencode when it is stale. */
  async function ensureModels() {
    if (!modelRegistry.isStale() && modelRegistry.size) return
    try {
      const payload = await ocClient.providers()
      modelRegistry.update(payload)
    } catch (err) {
      if (!modelRegistry.size) throw err
      app.log.warn({ err }, "could not refresh opencode model catalogue")
    }
  }

  return app
}
