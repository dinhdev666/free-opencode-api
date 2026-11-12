#!/usr/bin/env node
/**
 * Entry point: boots the opencode server (if needed) and the OpenAI-compatible
 * proxy.
 */

import { config } from "./config.js"
import { buildServer } from "./server.js"
import { OpencodeClient } from "./opencode-client.js"
import { startOpencodeServer, waitForExistingServer } from "./opencode-server.js"

const client = new OpencodeClient()
const app = buildServer({ client })

let child = null

async function boot() {
  if (config.spawnOpencode) {
    try {
      child = await startOpencodeServer(client, { log: (msg) => app.log.info(msg) })
    } catch (err) {
      app.log.error(err.message)
      const reused = await waitForExistingServer(client, { log: (msg) => app.log.info(msg) })
      if (!reused) {
        app.log.error("could not start or reach the opencode server")
        process.exit(1)
      }
    }
  } else {
    const ok = await waitForExistingServer(client, { log: (msg) => app.log.info(msg) })
    if (!ok) {
      app.log.error(`no opencode server reachable at ${client.baseUrl}`)
      process.exit(1)
    }
  }

  // Warm the model catalogue so the first request is fast.
  try {
    const payload = await client.providers()
    app.opencode.registry.update(payload)
    app.log.info(`loaded ${app.opencode.registry.size} models`)
  } catch (err) {
    app.log.warn({ err: err.message }, "could not load the opencode model catalogue")
  }

  await app.listen({ host: config.host, port: config.port })
  app.log.info(`OpenAI-compatible proxy listening on http://${config.host}:${config.port}`)
}

async function shutdown(signal) {
  app.log.info(`received ${signal}, shutting down`)
  try {
    await app.close()
  } catch {}
  try {
    await app.opencode.eventBus.close()
  } catch {}
  if (child) {
    try {
      child.kill()
    } catch {}
  }
  process.exit(0)
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))

boot().catch((err) => {
  console.error(err)
  process.exit(1)
})
