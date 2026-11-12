/**
 * Test helper: a mock OpenAI-compatible provider plus an opencode server
 * configured to use it.
 *
 * This lets the whole proxy be exercised without touching a real provider or
 * burning a free-tier quota.
 */

import { spawn } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { config } from "../src/config.js"

const here = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(here, "..")

/** Headers every test request sends (the proxy requires an API key). */
export function authHeaders() {
  return { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` }
}

/**
 * Starts a mock OpenAI-compatible endpoint.
 * @param {{reply?: string, onRequest?: (req) => any}} options
 */
export async function startMockProvider({ reply = "Hello from mock", onRequest } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      let parsed = null
      try {
        parsed = JSON.parse(raw)
      } catch {}
      const entry = { path: req.url, body: parsed, raw }
      requests.push(entry)

      if (onRequest) {
        const custom = onRequest(entry)
        if (custom) {
          res.writeHead(custom.status ?? 200, { "content-type": custom.contentType ?? "application/json" })
          res.end(custom.body ?? "")
          return
        }
      }

      if (parsed?.stream) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const base = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 1700000000, model: parsed.model }
        for (const piece of String(reply).split(/(?<= )/)) {
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`)
        }
        res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
        res.write("data: [DONE]\n\n")
        res.end()
        return
      }

      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: 1700000000,
          model: parsed?.model ?? "mock-model",
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        }),
      )
    })
  })

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  return {
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        // Keep-alive sockets would otherwise keep the server open forever.
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

/**
 * Kills a process and everything it spawned.
 *
 * The opencode binary is a wrapper that starts the real server as a child
 * process. Killing only the wrapper leaves the server alive, holding the
 * stdio pipes open, which keeps the test runner from exiting.
 */
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
    return
  }
  try {
    // Kill the whole process group: the negative pid reaches the children.
    process.kill(-child.pid, "SIGKILL")
  } catch {}
  try {
    child.kill("SIGKILL")
  } catch {}
}

/** Reserves a free TCP port from the OS. */
async function freePort() {
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/**
 * Boots an opencode server wired to the given mock provider.
 *
 * The provider has to be "connected" (via `PUT /auth/{providerID}`) before
 * opencode will talk to it, so the helper performs that step as well.
 *
 * @returns {Promise<{port: number, dir: string, close: () => Promise<void>}>}
 */
export async function startOpencodeWithMock(mock, { extraConfig = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-mock-"))
  fs.writeFileSync(
    path.join(dir, "opencode.json"),
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        // NOTE: opencode 1.19.x still reads the V1 config shape (`provider`,
        // `agent`). Mixing V1 and V2 keys in the same object silently drops
        // the V1-only keys, so keep this file purely V1.
        provider: {
          mock: {
            name: "Mock",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${mock.port}/v1` },
            models: { "mock-model": { name: "Mock Model", limit: { context: 128000, output: 8192 } } },
          },
        },
        agent: {
          proxy: {
            mode: "primary",
            prompt: "You are a helpful assistant.",
            // Denying each built-in tool by name removes its schema from the
            // upstream request. A deny-all rule would also remove opencode's
            // internal StructuredOutput tool, which is what carries our
            // emulated function calls.
            tools: {
              bash: false, read: false, glob: false, grep: false, edit: false, write: false,
              task: false, webfetch: false, todowrite: false, websearch: false, skill: false,
              apply_patch: false, invalid: false, question: false,
            },
          },
          // Without this, opencode spends a second LLM call on a session title.
          title: { disable: true },
        },
        compaction: { auto: false },
        ...extraConfig,
      },
      null,
      2,
    ),
  )

  // Let the OS pick a free port so parallel test files never collide.
  const port = await freePort()
  const bin = path.join(projectRoot, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode")
  const isWindows = process.platform === "win32"
  const child = spawn(
    isWindows ? process.env.COMSPEC || "cmd.exe" : bin,
    isWindows ? ["/c", bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"] : ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: dir,
      env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // On POSIX the child becomes a process-group leader, so the teardown can
      // kill the opencode server it starts as well.
      detached: !isWindows,
    },
  )
  child.stdout.on("data", () => {})
  child.stderr.on("data", () => {})
  // The pipes must not keep the event loop alive on their own; the teardown
  // ends the process explicitly.
  child.stdout.unref?.()
  child.stderr.unref?.()

  const deadline = Date.now() + 60000
  let lastError = ""
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`)
      if (res.ok) break
      lastError = `health returned ${res.status}`
    } catch (err) {
      lastError = err?.message ?? String(err)
    }
    if (child.exitCode !== null) {
      throw new Error(`the mock opencode server exited with code ${child.exitCode}: ${lastError}`)
    }
    if (Date.now() > deadline) {
      killTree(child)
      throw new Error(`the mock opencode server did not start within 60s: ${lastError}`)
    }
    await new Promise((r) => setTimeout(r, 300))
  }

  // Connect the mock provider so opencode treats it as an authorised account.
  const auth = await fetch(`http://127.0.0.1:${port}/auth/mock`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key: "test-key" }),
  })
  if (!auth.ok) {
    child.kill()
    throw new Error(`could not connect the mock provider: ${auth.status} ${await auth.text()}`)
  }

  return {
    port,
    dir,
    close: async () => {
      killTree(child)
      // Wait for the process to disappear so its stdio pipes are released.
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) return resolve()
        child.once("exit", resolve)
        setTimeout(resolve, 3000).unref?.()
      })
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}
