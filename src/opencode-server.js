/**
 * Supervises a locally installed `opencode serve` process.
 *
 * The opencode CLI is installed as a project devDependency, so the binary is
 * resolved from `node_modules/.bin` — never from a global install.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { config, projectRoot } from "./config.js"

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * Resolves the opencode executable.
 *
 * The `node_modules/.bin/opencode` entry is a shell script on POSIX and a
 * `.cmd` shim on Windows. The real executable lives in the package itself
 * (`node_modules/opencode-ai/bin/opencode`), so it is preferred: it starts
 * the same way everywhere and it does not need a command interpreter.
 */
export function resolveOpencodeBinary() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN

  const isWindows = process.platform === "win32"

  // The real executable, straight from the package.
  const packageBinary = path.join(projectRoot, "node_modules", "opencode-ai", "bin", isWindows ? "opencode.exe" : "opencode")
  if (existsSync(packageBinary)) return packageBinary

  // Fall back to the bin shim.
  const names = isWindows ? ["opencode.cmd", "opencode.exe", "opencode"] : ["opencode"]
  const roots = [path.join(projectRoot, "node_modules", ".bin"), path.join(here, "..", "node_modules", ".bin")]

  for (const root of roots) {
    for (const name of names) {
      const candidate = path.join(root, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Starts `opencode serve` and resolves once the server answers /global/health.
 * Returns the child process so the caller can shut it down.
 */
export async function startOpencodeServer(client, { log = console.log } = {}) {
  const bin = resolveOpencodeBinary()
  if (!bin) {
    throw new Error(
      "opencode binary not found in node_modules/.bin. Run `pnpm install` in the project root.",
    )
  }

  const args = ["serve", "--hostname", config.opencodeHost, "--port", String(config.opencodePort)]
  const env = { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" }
  if (config.opencodePassword) env.OPENCODE_SERVER_PASSWORD = config.opencodePassword
  if (config.opencodeUsername) env.OPENCODE_SERVER_USERNAME = config.opencodeUsername
  // opencode has no per-request token limit, so the OpenAI `max_tokens` field
  // is mapped onto this server-wide cap.
  if (config.maxOutputTokens > 0) {
    env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX = String(config.maxOutputTokens)
  }

  // On Windows the shim is a `.cmd` file, which cannot be spawned directly —
  // it has to be run through the command interpreter.
  const isWindows = process.platform === "win32"
  const command = isWindows ? process.env.COMSPEC || "cmd.exe" : bin
  const commandArgs = isWindows ? ["/c", bin, ...args] : args

  const child = spawn(command, commandArgs, {
    cwd: config.workdir,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
    if (stderr.length > 8000) stderr = stderr.slice(-8000)
  })
  child.stdout?.resume()

  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      log(`[opencode] process exited with code ${code}`)
    }
  })

  const deadline = Date.now() + config.startupTimeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode server exited during startup (code ${child.exitCode}).\n${stderr.trim()}`)
    }
    try {
      const health = await client.health()
      if (health?.healthy) {
        log(`[opencode] server ready at ${client.baseUrl} (v${health.version})`)
        return child
      }
    } catch {
      // not up yet
    }
    await sleep(300)
  }

  child.kill()
  throw new Error(`opencode server did not become ready within ${config.startupTimeout / 1000}s`)
}

/** Waits for an already-running opencode server to answer. */
export async function waitForExistingServer(client, { log = console.log, timeout = 5000 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const health = await client.health()
      if (health?.healthy) {
        log(`[opencode] using running server at ${client.baseUrl} (v${health.version})`)
        return true
      }
    } catch {
      // not up yet
    }
    await sleep(250)
  }
  return false
}
