/**
 * Tests for the opencode binary resolution and the deployment wiring.
 *
 * The proxy runs the opencode executable itself, so a wrong path means the
 * proxy cannot start at all — most visibly inside the Docker image, where the
 * layout differs from a checkout.
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { resolveOpencodeBinary } from "../src/opencode-server.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

test("the opencode binary is found", () => {
  const bin = resolveOpencodeBinary()
  assert.ok(bin, "the opencode binary could not be found")
  assert.ok(fs.existsSync(bin), `the resolved binary does not exist: ${bin}`)
})

test("the resolved binary is the real executable, not the bin shim", () => {
  const bin = resolveOpencodeBinary()
  // The shim in node_modules/.bin is a shell script or a .cmd file; the real
  // executable lives in the package itself.
  assert.ok(!bin.includes(`${path.sep}.bin${path.sep}`), `expected the package binary, got: ${bin}`)
})

test("the binary is executable", () => {
  const bin = resolveOpencodeBinary()
  // Windows does not use the exec bit.
  if (process.platform === "win32") return
  const mode = fs.statSync(bin).mode
  assert.ok(mode & 0o111, `the binary is not executable: ${bin} (mode ${mode.toString(8)})`)
})

test("the opencode package ships the binary the resolver looks for", () => {
  const packageBin = path.join(root, "node_modules", "opencode-ai", "bin")
  const names = fs.existsSync(packageBin) ? fs.readdirSync(packageBin) : []
  assert.ok(
    names.includes("opencode.exe") || names.includes("opencode"),
    `expected a binary in node_modules/opencode-ai/bin, found: ${names.join(", ")}`,
  )
})

test("the Dockerfile copies everything the proxy needs at runtime", () => {
  const dockerfile = read("Dockerfile")
  assert.match(dockerfile, /COPY\s+--from=deps\s+\/app\/node_modules\s+\.\/node_modules/)
  assert.match(dockerfile, /COPY\s+src\s+\.\/src/)
  assert.match(dockerfile, /COPY\s+package\.json\s+opencode\.json/)
})

test("the Dockerfile installs only the production dependencies", () => {
  // The image must not carry the test-only OpenAI SDK.
  const dockerfile = read("Dockerfile")
  assert.match(dockerfile, /pnpm install --frozen-lockfile --prod/)
})

test("the proxy starts the opencode server itself", () => {
  const config = read("src/config.js")
  assert.match(config, /spawnOpencode: bool\("SPAWN_OPENCODE", true\)/)
})
