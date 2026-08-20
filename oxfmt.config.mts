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
  ignorePatterns: ["**/.next", "**/private_notes", "**/lib/typescript/ui/src"],
})
