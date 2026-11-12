/**
 * Configuration for the OpenAI-compatible proxy.
 *
 * Everything is driven by environment variables. A `.env` file in the project
 * root is loaded automatically (no dotenv dependency — the parser below is a
 * few lines and keeps the dependency surface minimal).
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const projectRoot = path.resolve(here, "..")

/**
 * Minimal .env parser: `KEY=value` lines, `#` comments, optional quotes.
 * Existing environment variables always win.
 */
function loadDotEnv(file = path.join(projectRoot, ".env")) {
  let raw
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    return
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const eq = trimmed.indexOf("=")
    if (eq === -1) continue

    const key = trimmed.slice(0, eq).trim()
    if (!key || key in process.env) continue

    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

loadDotEnv()

function num(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

function list(name) {
  const raw = process.env[name]
  if (!raw) return []
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

export const config = {
  /** Host the proxy listens on. */
  host: process.env.HOST || "0.0.0.0",
  /** Port the proxy listens on. */
  port: num("PORT", 20128),

  /**
   * API key clients must present as `Authorization: Bearer <key>`.
   * The default keeps the proxy usable out of the box while still rejecting
   * requests that send no key at all.
   */
  apiKey: process.env.API_KEY || "sk-dummy",

  /** Working directory used as the opencode project root. */
  workdir: process.env.OPENCODE_WORKDIR || projectRoot,

  /** Hostname of the opencode server we talk to. */
  opencodeHost: process.env.OPENCODE_HOST || "127.0.0.1",
  /** Port of the opencode server we talk to. */
  opencodePort: num("OPENCODE_PORT", 4096),
  /**
   * When true the proxy spawns and supervises its own `opencode serve`
   * process. When false it assumes a server is already running.
   */
  spawnOpencode: bool("SPAWN_OPENCODE", true),
  /** Seconds to wait for the spawned opencode server to become healthy. */
  startupTimeout: num("OPENCODE_STARTUP_TIMEOUT", 30) * 1000,
  /** Basic-auth password for the opencode server (OPENCODE_SERVER_PASSWORD). */
  opencodePassword: process.env.OPENCODE_SERVER_PASSWORD || "",
  opencodeUsername: process.env.OPENCODE_SERVER_USERNAME || "opencode",

  /** Default model used when the client does not ask for one. */
  defaultModel: process.env.DEFAULT_MODEL || "",
  /** Default provider used when the client does not ask for one. */
  defaultProvider: process.env.DEFAULT_PROVIDER || "opencode",
  /** Default opencode agent (build / plan / general / explore / proxy). */
  defaultAgent: process.env.DEFAULT_AGENT || "proxy",

  /** How long (ms) a single chat completion may take. */
  requestTimeout: num("REQUEST_TIMEOUT", 300) * 1000,
  /**
   * How many provider retries opencode may make before the proxy gives up and
   * reports the failure. opencode's own default is 5 retries with a 2s -> 30s
   * backoff, which means a failing provider blocks a request for ~90 seconds.
   */
  maxRetryAttempts: num("MAX_RETRY_ATTEMPTS", 1),

  /**
   * Delete each opencode session after the request finished. Off by default:
   * it costs one extra HTTP request per completion and opencode prunes its
   * own history anyway.
   */
  deleteSessions: bool("DELETE_SESSIONS", false),

  /** Advertised as the OpenAI organisation / owner for /v1/models. */
  owner: process.env.MODEL_OWNER || "opencode",

  /**
   * pino log level. `silent` by default: the proxy writes no log files and
   * keeps stdout quiet, which is what a container or a small VPS wants.
   */
  logLevel: process.env.LOG_LEVEL || "silent",
}

export const opencodeBaseUrl = `http://${config.opencodeHost}:${config.opencodePort}`
