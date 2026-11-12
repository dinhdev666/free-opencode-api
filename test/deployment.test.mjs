/**
 * Guards the deployment configuration.
 *
 * Railway rejects a Dockerfile that contains a VOLUME instruction — the build
 * stops during validation with "The Dockerfile failed validation". The
 * volume has to be attached in the Railway dashboard instead.
 */

import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const read = (file) => fs.readFileSync(path.join(root, file), "utf8")

const dockerfile = read("Dockerfile")
const railway = JSON.parse(read("railway.json"))

test("the Dockerfile has no VOLUME instruction", () => {
  const offenders = dockerfile
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter((entry) => /^VOLUME\b/i.test(entry.line))

  assert.deepEqual(
    offenders.map((entry) => entry.number),
    [],
    "Railway rejects a Dockerfile with a VOLUME instruction; attach the volume in the dashboard",
  )
})

test("the image listens on every interface", () => {
  assert.match(dockerfile, /HOST=0\.0\.0\.0/)
})

test("the image exposes the proxy port", () => {
  assert.match(dockerfile, /EXPOSE\s+20128/)
})

test("the image has a health check", () => {
  assert.match(dockerfile, /^HEALTHCHECK\b/m)
})

test("the image starts the proxy", () => {
  assert.match(dockerfile, /^ENTRYPOINT\b/m)
  assert.match(dockerfile, /^CMD\b/m)
})

test("the image keeps the opencode state on /data", () => {
  assert.match(dockerfile, /XDG_DATA_HOME=\/data/)
})

test("railway.json builds the Dockerfile and checks the health endpoint", () => {
  assert.equal(railway.build.builder, "DOCKERFILE")
  assert.equal(railway.build.dockerfilePath, "Dockerfile")
  assert.equal(railway.deploy.healthcheckPath, "/health")
})

test("railway.json does not force a mount path", () => {
  // `requiredMountPath` makes the deployment fail when no volume exists.
  assert.equal(railway.deploy.requiredMountPath, undefined)
})

test("the container runs as a non-root user", () => {
  assert.match(dockerfile, /^USER\s+node\b/m)
})

test("the image keeps the opencode workdir on the volume", () => {
  // opencode snapshots its workdir, so it has to live on the volume rather
  // than in the read-only image layer.
  assert.match(dockerfile, /OPENCODE_WORKDIR=\/data/)
})

test("the image gives the node user its own data directory", () => {
  assert.match(dockerfile, /mkdir -p \/data && chown -R node:node \/data \/app/)
})
