/**
 * Unit tests for the model registry.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { ModelRegistry } from "../src/model-registry.js"

const CATALOGUE = {
  all: [
    {
      id: "opencode",
      name: "OpenCode",
      models: {
        "glm-5.3-flash-free": { name: "GLM", limit: { context: 1 } },
        "deepseek-v4.1-flash-free": { name: "DeepSeek", limit: { context: 2 } },
      },
    },
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": { name: "Claude", limit: { context: 3 } },
        "glm-5.3-flash-free": { name: "Claude GLM", limit: { context: 4 } },
      },
    },
  ],
  connected: ["opencode"],
}

test("the registry counts the catalogue models", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  assert.equal(registry.size, 4)
})

test("a fully qualified model id resolves", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  const entry = registry.resolve("anthropic/claude-sonnet-4-6")
  assert.equal(entry.providerID, "anthropic")
  assert.equal(entry.modelID, "claude-sonnet-4-6")
  assert.equal(entry.id, "anthropic/claude-sonnet-4-6")
})

test("a bare model id prefers a connected provider", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  const entry = registry.resolve("glm-5.3-flash-free")
  assert.equal(entry.providerID, "opencode")
  assert.equal(entry.connected, true)
})

test("a bare model id falls back to any provider", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  const entry = registry.resolve("claude-sonnet-4-6")
  assert.equal(entry.providerID, "anthropic")
  assert.equal(entry.connected, false)
})

test("a #variant suffix is kept", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  const entry = registry.resolve("anthropic/claude-sonnet-4-6#high")
  assert.equal(entry.modelID, "claude-sonnet-4-6")
  assert.equal(entry.variant, "high")
})

test("an unknown model resolves to undefined", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  assert.equal(registry.resolve("nope/nope"), undefined)
  assert.equal(registry.resolve("nope"), undefined)
  assert.equal(registry.resolve(""), undefined)
  assert.equal(registry.resolve(undefined), undefined)
})

test("the model list follows the OpenAI shape", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  const list = registry.list("opencode")

  assert.equal(list.object, "list")
  assert.equal(list.data.length, 4)

  const connected = list.data.find((m) => m.id === "opencode/glm-5.3-flash-free")
  assert.equal(connected.object, "model")
  assert.equal(connected.owned_by, "opencode")
  assert.equal(typeof connected.created, "number")

  const disconnected = list.data.find((m) => m.id === "anthropic/claude-sonnet-4-6")
  assert.equal(disconnected.owned_by, "opencode:anthropic")
})

test("the registry does not keep the raw catalogue alive", () => {
  const registry = new ModelRegistry()
  const payload = JSON.parse(JSON.stringify(CATALOGUE))
  registry.update(payload)
  payload.all = null
  assert.equal(registry.size, 4)
  assert.ok(registry.resolve("opencode/glm-5.3-flash-free"))
})

test("the registry goes stale after its ttl", () => {
  const registry = new ModelRegistry()
  registry.update(CATALOGUE)
  assert.equal(registry.isStale(), false)
  registry.ttl = -1
  assert.equal(registry.isStale(), true)
})
