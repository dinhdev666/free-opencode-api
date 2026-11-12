// Checks the Dockerfile against the rules Railway enforces.
import fs from "node:fs"

const source = fs.readFileSync("Dockerfile", "utf8")
const lines = source.split(/\r?\n/)

const problems = []
const note = (message) => problems.push(message)

let hasVolume = false
let hasEntrypoint = false
let hasCmd = false
let hasHealthcheck = false
let exposes = 0
let user = null
let workdir = null

for (const [index, line] of lines.entries()) {
  const number = index + 1
  const trimmed = line.trim()

  if (/^VOLUME\b/i.test(trimmed)) {
    hasVolume = true
    note(`line ${number}: VOLUME is forbidden, Railway rejects the build`)
  }
  if (/^ENTRYPOINT\b/i.test(trimmed)) hasEntrypoint = true
  if (/^CMD\b/i.test(trimmed)) hasCmd = true
  if (/^HEALTHCHECK\b/i.test(trimmed)) hasHealthcheck = true
  if (/^EXPOSE\b/i.test(trimmed)) exposes++
  if (/^USER\s+(\S+)/i.test(trimmed)) user = trimmed.split(/\s+/)[1]
  if (/^WORKDIR\s+(\S+)/i.test(trimmed)) workdir = trimmed.split(/\s+/)[1]
}

// The path the opencode state lives on. A Railway volume is mounted there.
if (!source.includes("XDG_DATA_HOME=/data")) {
  note("XDG_DATA_HOME is not set to /data, so a Railway volume would not be used")
}

// The proxy has to listen on every interface for Railway to reach it.
if (!/ENV[\s\S]*?HOST=0\.0\.0\.0/.test(source)) {
  note("HOST=0.0.0.0 is missing, Railway cannot reach the proxy")
}

// The proxy has to honour the port Railway injects.
if (!/ENV[\s\S]*?PORT=20128/.test(source)) {
  note("PORT is not in the image environment")
}

if (!hasEntrypoint) note("no ENTRYPOINT, the container would not start the proxy")
if (!hasCmd) note("no CMD")
if (!hasHealthcheck) note("no HEALTHCHECK")
if (exposes === 0) note("no EXPOSE")
if (user !== "node") note(`the container should run as a non-root user, found: ${user}`)
if (workdir !== "/app") note(`unexpected WORKDIR: ${workdir}`)

// The proxy is started by the CMD, so the source has to be copied in.
if (!/COPY\s+src\s+\.\/src/.test(source)) note("the src directory is not copied into the image")

console.log("Railway Dockerfile checks")
for (const problem of problems) console.log(`  FAIL ${problem}`)
if (!problems.length) console.log("  all checks passed")

process.exit(problems.length ? 1 : 0)
