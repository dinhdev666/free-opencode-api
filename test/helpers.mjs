/**
 * Test helper: a mock OpenAI-compatible provider plus an opencode server
 * configured to use it.
 *
 * This lets the whole proxy be exercised without touching a real provider or
 * burning a free-tier quota.
 */

import { spawn } from "node:child_process"
import { execFile } from "node:child_process"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { config } from "../src/config.js"
import { resolveOpencodeBinary } from "../src/opencode-server.js"

const run = promisify(execFile)

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
    child.kill("SIGKILL")
  } catch {}
}

/**
 * Writes a progress marker to stderr.
 *
 * The test runner only reports a file-level timeout, so these markers make
 * it possible to see how far a hanging test got.
 */
export function mark(step) {
  if (process.env.TEST_TRACE) process.stderr.write(`[trace] ${step}\n`)
}

/**
 * Picks a free TCP port from a high range.
 *
 * The port is released before opencode binds it, so there is a small window
 * in which something else could take it. The range is far away from the
 * ports the rest of the system uses, which makes a collision unlikely.
 */
async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const probe = http.createServer()
    await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
    const { port } = probe.address()
    await new Promise((resolve) => probe.close(resolve))
    if (port > 20000) return port
  }
  throw new Error("could not find a free port")
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

  // Pick a port from a high range that nothing else uses. `opencode serve
  // --port 0` would prefer 4096, and a leftover server on that port would
  // break the next one.
  const port = await freePort()
  mark(`starting opencode on port ${port}`)
  // Use the real executable rather than the bin shim: the shim is a shell
  // script on POSIX and a .cmd on Windows, and the two behave differently.
  const bin = resolveOpencodeBinary()
  if (!bin) throw new Error("the opencode binary could not be found")
  const isWindows = process.platform === "win32"
  const child = spawn(
    isWindows ? process.env.COMSPEC || "cmd.exe" : bin,
    isWindows ? ["/c", bin, "serve", "--port", String(port), "--hostname", "127.0.0.1"] : ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: dir,
      env: {
        ...process.env,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        // Every server gets its own state directory. Otherwise they all share
        // one SQLite database, and a lock held by one instance stalls the
        // others.
        XDG_DATA_HOME: path.join(dir, "data"),
        XDG_CONFIG_HOME: path.join(dir, "config"),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  )
  let stderr = ""
  let stdout = ""
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
    if (stdout.length > 4000) stdout = stdout.slice(-4000)
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
    if (stderr.length > 4000) stderr = stderr.slice(-4000)
  })
  // The pipes must not keep the event loop alive on their own; the teardown
  // ends the process explicitly.
  child.stdout.unref?.()
  child.stderr.unref?.()

  // A cold CI runner can take a while: the binary is large and the first
  // start builds the provider catalogue.
  const deadline = Date.now() + 180000
  let lastError = ""
  for (;;) {
    try {
      // The health check needs its own timeout: a busy server accepts the
      // connection but does not answer, and an unanswered fetch would hang
      // the whole test file.
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
        signal: AbortSignal.timeout(10000),
      })
      if (res.ok) break
      lastError = `health returned ${res.status}`
    } catch (err) {
      lastError = err?.message ?? String(err)
    }
    if (child.exitCode !== null) {
      throw new Error(
        `the mock opencode server exited with code ${child.exitCode}: ${lastError}\n${stderr.trim()}`,
      )
    }
    if (Date.now() > deadline) {
      killTree(child)
      throw new Error(
        `the mock opencode server did not start within 180s: ${lastError}\n${stderr.trim()}`,
      )
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  mark(`opencode is listening on port ${port}`)
  // Connect the mock provider so opencode treats it as an authorised account.
  const auth = await fetch(`http://127.0.0.1:${port}/auth/mock`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key: "test-key" }),
    signal: AbortSignal.timeout(30000),
  })
  if (!auth.ok) {
    killTree(child)
    throw new Error(`could not connect the mock provider: ${auth.status} ${await auth.text()}`)
  }

  // The catalogue call is the first heavy request; it can be slow on a cold
  // server, so it gets its own generous budget.
  const catalogue = await fetch(`http://127.0.0.1:${port}/provider`, {
    signal: AbortSignal.timeout(180000),
  })
  if (!catalogue.ok) {
    killTree(child)
    throw new Error(`could not read the provider catalogue: ${catalogue.status}`)
  }
  mark("provider catalogue loaded")

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
      // The opencode binary starts the real server as a child process. If it
      // is still holding the port, the next test would talk to it instead of
      // to a fresh server.
      await killPortOwner(port)
      // Wait until the port is free again, so the next server can bind it.
      await waitForFreePort(port)
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {}
    },
  }
}

/**
 * Waits until nothing answers on a TCP port.
 */
async function waitForFreePort(port) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/global/health`, {
        signal: AbortSignal.timeout(1000),
      })
      await res.arrayBuffer()
    } catch {
      return
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

/**
 * Kills whatever process is still listening on a TCP port.
 *
 * On Linux the owner is found by reading `/proc`, which needs no extra tool.
 * On macOS `lsof` does the job. A failure is ignored: the port is released
 * when the process exits anyway.
 */
async function killPortOwner(port) {
  const pids = await portOwners(port)
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  }
}

/** Finds the process ids listening on a TCP port. */
async function portOwners(port) {
  if (process.platform === "linux") {
    const pids = new Set()
    // Every socket shows up as an inode in /proc/net/tcp.
    const inodes = new Set()
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      let content
      try {
        content = await fs.promises.readFile(file, "utf8")
      } catch {
        continue
      }
      for (const line of content.split("\n").slice(1)) {
        const columns = line.trim().split(/\s+/)
        if (columns.length < 10) continue
        const local = columns[1]
        const state = columns[3]
        if (state !== "0A") continue // LISTEN
        if (Number(local.split(":")[1], 16) !== port) continue
        inodes.add(columns[9])
      }
    }
    if (!inodes.size) return []

    for (const entry of await fs.promises.readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      let fds
      try {
        fds = await fs.promises.readdir(`/proc/${entry}/fd`)
      } catch {
        continue
      }
      for (const fd of fds) {
        try {
          const link = await fs.promises.readlink(`/proc/${entry}/fd/${fd}`)
          const match = /^socket:\[(\d+)\]$/.exec(link)
          if (match && inodes.has(match[1])) {
            pids.add(Number(entry))
            break
          }
        } catch {}
      }
    }
    return [...pids]
  }

  if (process.platform === "darwin") {
    try {
      const { stdout } = await run("lsof", ["-ti", `tcp:${port}`], { timeout: 5000 })
      return stdout
        .trim()
        .split(/\s+/)
        .filter((pid) => /^\d+$/.test(pid))
        .map(Number)
    } catch {
      return []
    }
  }

  return []
}
