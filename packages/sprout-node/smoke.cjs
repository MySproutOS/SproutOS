"use strict"

const assert = require("node:assert/strict")
const { applyTemplate } = require("./index.cjs")

applyTemplate({})
  .then(() => {
    throw new Error("invalid native input unexpectedly succeeded")
  })
  .catch((error) => {
    assert.equal(error.name, "SproutNodeError")
    assert.equal(error.code, "invalid_input")
    assert.equal(error.retryable, false)
    process.stdout.write("sprout-node native async boundary loaded and preserved core errors\n")
  })
