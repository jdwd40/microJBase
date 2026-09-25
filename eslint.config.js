import js from "@eslint/js"
import prettier from "eslint-config-prettier"
import tseslint from "typescript-eslint"

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The management UI client is dependency-free browser JavaScript. Give it
    // read-only browser globals; it deliberately never touches storage APIs
    // (localStorage/sessionStorage) — that invariant is unit-tested.
    files: ["admin-ui/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        document: "readonly",
        window: "readonly",
        fetch: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        URL: "readonly",
        HTMLFormElement: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
      },
    },
  },
  prettier,
)
