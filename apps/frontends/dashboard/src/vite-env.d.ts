/// <reference types="vite/client" />

/**
 * The constants `viteDefine` substitutes at build time.
 *
 * There is no `process` in a browser. These names exist because Vite replaces the literal text
 * `process.env.STRIPE_PUBLIC_KEY` with a string during the build — so they are compile-time
 * constants wearing a runtime object's clothes.
 *
 * Declared one at a time rather than by adding `"types": ["node"]` to this app's tsconfig. That
 * would make the whole Node API type-check inside browser code: `fs.readFileSync` in a component
 * would compile cleanly and fail in the tab. Listing the two names that genuinely get substituted
 * says exactly what exists, and anything else stays the error it should be.
 */
declare const process: {
  env: {
    NODE_ENV: string
    NEXT_PUBLIC_API_URL: string
    /** Stripe's publishable key. Empty when card payments are not configured. */
    STRIPE_PUBLIC_KEY: string
  }
}
