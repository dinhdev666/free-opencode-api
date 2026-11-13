// Does the SDK's stream accumulator work with and without usage?
import { startMockProvider, startOpencodeWithMock } from "../test/helpers.mjs"
import { buildServer } from "../src/server.js"
import { ModelRegistry } from "../src/model-registry.js"
import { EventBus } from "../src/event-bus.js"

const mock = await startMockProvider({ reply: "Hello from mock" })
const oc = await startOpencodeWithMock(mock)
const client = oc.client()
const registry = new ModelRegistry()
registry.update(await client.providers())
const app = buildServer({ client, registry, eventBus: new EventBus(client) })
await app.listen({ host: "127.0.0.1", port: 0 })
const base = `http://127.0.0.1:${app.server.address().port}/v1`

const { default: OpenAI } = await import("openai")
const openai = new OpenAI({ baseURL: base, apiKey: "sk-dummy" })

for (const includeUsage of [true, false]) {
  const stream = await openai.chat.completions.create({
    model: "mock/mock-model",
    messages: [{ role: "user", content: "Hello" }],
    stream: true,
    stream_options: { include_usage: includeUsage },
  })

  let text = ""
  let usage = null
  let chunks = 0
  for await (const chunk of stream) {
    chunks++
    text += chunk.choices[0]?.delta?.content ?? ""
    if (chunk.usage) usage = chunk.usage
  }
  console.log(`include_usage=${includeUsage}: text=${JSON.stringify(text)} chunks=${chunks} usage=${JSON.stringify(usage)}`)
}

await app.opencode.eventBus.close()
await app.close()
await oc.close()
await mock.close()
process.exit(0)
