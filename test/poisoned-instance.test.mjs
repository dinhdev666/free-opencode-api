// Does the proxy recover from a poisoned opencode instance?
//
// The instance is poisoned by an aborted request. The proxy disposes it
// afterwards, so the state has to be forced here to check the recovery.

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
import { OpencodeError } from "../src/opencode-client.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"
import { authHeaders, startMockProvider, startOpencodeWithMock } from "./helpers.mjs"

let mock
let oc
let app
let baseUrl

test.before(async () => {
  mock = await startMockProvider({ reply: "answer" })
  oc = await startOpencodeWithMock(mock)

  const client = oc.client()
  const registry = new ModelRegistry()
  registry.update(await client.providers())

  app = buildServer({ client, registry, eventBus: new EventBus(client) })
  await app.listen({ host: "127.0.0.1", port: 0 })
  baseUrl = `http://127.0.0.1:${app.server.address().port}/v1/chat/completions`
})

test.after(async () => {
  await app?.opencode?.eventBus?.close()
  await app?.close()
  await oc?.close()
  await mock?.close()
})

test("the proxy recovers from a poisoned opencode instance", async () => {
  // A poisoned instance answers every request with an empty 499. The proxy
  // has to recognise that, dispose the instance and try again — so the first
  // call fails and the second one works.
  const client = app.opencode.client
  const originalCreate = client.createSession.bind(client)
  let poisoned = true

  client.createSession = async (title) => {
    if (!poisoned) return originalCreate(title)
    poisoned = false
    throw new OpencodeError("HTTP 499", { status: 499, code: "opencode_error" })
  }

  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

    assert.equal(res.status, 200, `unexpected status: ${await res.clone().text()}`)
    const body = await res.json()
    assert.equal(body.choices[0].message.content, "answer")
  } finally {
    client.createSession = originalCreate
  }
})
