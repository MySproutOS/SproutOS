"use strict"

/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access, typescript/use-unknown-in-catch-callback-variable -- This executable exercises the untyped CommonJS ABI boundary; index.d.ts covers consumers. */

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
