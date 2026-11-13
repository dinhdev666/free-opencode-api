#!/usr/bin/env node
/**
 * A tiny, dependency-free lint pass.
 *
 * The project deliberately keeps its dependency surface at three runtime
 * packages, so it does not pull in ESLint. This script catches the mistakes
 * that actually happen in this codebase:
 *
 *   - a syntax error (every file is parsed with `node --check`)
 *   - a `console.log` left in the source
 *   - a `debugger` statement
 *   - a TODO/FIXME marker
 *   - trailing whitespace
 *   - tabs used for indentation
 *   - a missing final newline
 */

import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")

const DIRECTORIES = ["src", "test", "scripts"]
const IGNORED = new Set(["node_modules", ".git", "coverage"])

const RULES = [
  {
    name: "no-console",
    pattern: /^\s*console\.(log|debug|info|warn|error)\(/,
    message: "console output left in the source; the proxy stays silent by default",
    // The lint script and the Dockerfile check report their findings on the
    // console, that is their whole job.
    skip: (file) => file.startsWith("scripts/"),
  },
  {
    name: "no-debugger",
    pattern: /^\s*debugger\b/,
    message: "debugger statement",
  },
  {
    name: "no-todo",
    pattern: /\b(TODO|FIXME|XXX|HACK)\b/,
    message: "unresolved marker",
    // The rule definition mentions the markers it looks for.
    skip: (file) => file.startsWith("scripts/"),
  },
  {
    name: "no-tabs",
    pattern: /^\t/,
    message: "tab used for indentation; this project indents with two spaces",
  },
]

function collectFiles(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectFiles(full, out)
    else if (entry.isFile() && /\.(js|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Parses a file with `node --check` and returns the error message, if any. */
async function syntaxError(file) {
  try {
    await run(process.execPath, ["--check", file])
    return undefined
  } catch (err) {
    return (err.stderr || err.message || "").split("\n").slice(0, 4).join(" ").trim()
  }
}

const problems = []
const files = DIRECTORIES.flatMap((dir) => collectFiles(path.join(root, dir)))

for (const file of files) {
  // Normalise the separator so the skip rules work on every platform.
  const relative = path.relative(root, file).split(path.sep).join("/")
  const source = fs.readFileSync(file, "utf8")

  const error = await syntaxError(file)
  if (error) {
    problems.push(`${relative}: syntax error: ${error}`)
    continue
  }

  const lines = source.split(/\r?\n/)

  lines.forEach((line, index) => {
    if (/\s$/.test(line)) {
      problems.push(`${relative}:${index + 1}: trailing whitespace`)
    }
    for (const rule of RULES) {
      if (rule.skip?.(relative)) continue
      if (!rule.pattern.test(line)) continue
      // A `lint-ignore` comment on the previous line waives the rule.
      const previous = index > 0 ? lines[index - 1] : ""
      if (/lint-ignore/.test(previous)) continue
      problems.push(`${relative}:${index + 1}: ${rule.name} — ${rule.message}`)
    }
  })

  if (source.length > 0 && !source.endsWith("\n")) {
    problems.push(`${relative}: missing final newline`)
  }
}

// Scratch files must never end up in the repository.
const KEEP_AT_ROOT = new Set([
  ".dockerignore",
  ".env",
  ".env.example",
  ".gitattributes",
  ".gitignore",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "Dockerfile",
  "LICENSE",
  "Procfile",
  "README.md",
  "docker-compose.yml",
  "opencode.json",
  "package.json",
  "pnpm-lock.yaml",
  "railway.json",
])

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isDirectory()) continue
  if (KEEP_AT_ROOT.has(entry.name)) continue
  if (entry.name.startsWith(".")) continue
  problems.push(`${entry.name}: unexpected file in the project root`)
}

if (problems.length) {
  console.error(`lint failed with ${problems.length} problem(s):\n`)
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}

console.log(`lint passed (${files.length} files)`)
