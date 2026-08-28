"use strict"

const { loadNative } = require("./loader.cjs")
const native = loadNative()

class SproutNodeError extends Error {
  constructor(envelope, cause) {
    super(envelope.message, { cause })
    this.name = "SproutNodeError"
    this.code = envelope.code
    this.retryable = envelope.retryable
  }
}

async function applyTemplate(input) {
  try {
    const result = await native.applyTemplateJson(JSON.stringify(input))
    // napi-rs represents a Rust `Err` from an async export as the promise value on some Node
    // versions instead of rejecting it. Normalize both ABI behaviours at this one boundary.
    if (result instanceof Error) throw result
    return JSON.parse(result)
  } catch (cause) {
    let reason = cause instanceof Error ? cause.message : String(cause)
    while (reason.startsWith("Error: ")) reason = reason.slice("Error: ".length)
    try {
      const envelope = JSON.parse(reason)
      throw new SproutNodeError(envelope, cause)
    } catch (parseError) {
      if (parseError instanceof Error && parseError.name === "SproutNodeError") throw parseError
      throw cause
    }
  }
}

function nativeRuntimeStatus() {
  return JSON.parse(native.nativeRuntimeStatusJson())
}

module.exports = { applyTemplate, nativeRuntimeStatus, SproutNodeError }
