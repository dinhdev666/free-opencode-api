import test from "node:test"
import assert from "node:assert/strict"

import { usageFrom } from "../src/service.js"

/**
 * opencode splits the token counts differently from OpenAI: its `input` is
 * the raw input minus the cached tokens, and its `output` is the raw output
 * minus the reasoning tokens.
 */
test("usageFrom reports the counts opencode sent", () => {
  const usage = usageFrom({
    total: 18,
    input: 11,
    output: 7,
    reasoning: 0,
    cache: { write: 0, read: 0 },
  })

  assert.equal(usage.prompt_tokens, 11)
  assert.equal(usage.completion_tokens, 7)
  assert.equal(usage.total_tokens, 18)
})

test("usageFrom counts the cached tokens as prompt tokens", () => {
  const usage = usageFrom({
    total: 100,
    input: 60,
    output: 10,
    reasoning: 0,
    cache: { write: 20, read: 30 },
  })

  // 60 input + 30 read + 20 write
  assert.equal(usage.prompt_tokens, 110)
  assert.equal(usage.completion_tokens, 10)
  assert.equal(usage.total_tokens, 100)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 30)
  assert.equal(usage.prompt_tokens_details.cache_write_tokens, 20)
})

test("usageFrom counts the reasoning tokens as completion tokens", () => {
  const usage = usageFrom({
    total: 50,
    input: 20,
    output: 10,
    reasoning: 20,
    cache: { write: 0, read: 0 },
  })

  assert.equal(usage.prompt_tokens, 20)
  // 10 output + 20 reasoning
  assert.equal(usage.completion_tokens, 30)
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 20)
  assert.equal(usage.total_tokens, 50)
})

test("usageFrom survives missing token fields", () => {
  assert.deepEqual(usageFrom(undefined), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  })
  assert.deepEqual(usageFrom({}), {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  })
})
