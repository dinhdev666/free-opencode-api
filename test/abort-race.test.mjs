// Several clients disconnect at the same time, then a new one arrives.
//
// The aborts poison the opencode instance of the project, and the disposals
// that clean it up race each other. The proxy has to end up in a state where
// the next request works.

import test from "node:test"
import assert from "node:assert/strict"

import { buildServer } from "../src/server.js"
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

test("several disconnects at once leave the proxy usable", async () => {
  // Five clients disconnect while their requests are still running. The
  // disposals that clean up after them race each other, and a disposal that
  // pulls the instance down while another request uses it poisons it again.
  const controllers = Array.from({ length: 5 }, () => new AbortController())
  const running = controllers.map((controller) =>
    fetch(baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    }).catch(() => {}),
  )

  await new Promise((resolve) => setTimeout(resolve, 50))
  for (const controller of controllers) controller.abort()
  await Promise.all(running)

  // The cleanup needs a moment.
  await new Promise((resolve) => setTimeout(resolve, 2000))

  const send = () =>
    fetch(baseUrl, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        model: "mock/mock-model",
        messages: [{ role: "user", content: "Hello" }],
      }),
    })

  // The next request has to work. It may have to be tried twice: the first
  // attempt can still meet the poisoned instance, and the proxy recovers by
  // disposing it.
  let res = await send()
  if (res.status !== 200) res = await send()

  assert.equal(res.status, 200, `unexpected status: ${await res.clone().text()}`)
  const body = await res.json()
  assert.equal(body.choices[0].message.content, "answer")
})
