import { defineConfig } from "oxfmt"

export default defineConfig({
  useTabs: false,
  tabWidth: 2,
  printWidth: 100,
  singleQuote: false,
  jsxSingleQuote: false,
  quoteProps: "as-needed",
  trailingComma: "all",
  semi: false,
  arrowParens: "always",
  bracketSameLine: false,
  bracketSpacing: true,
  // design/ holds design-canvas source and generated artboards. Wrapping style
  // attributes across six lines each makes the design unreadable, and the .dc.html
  // output is generated anyway.
  ignorePatterns: ["**/.next", "**/private_notes", "**/lib/typescript/ui/src", "design"],
})
