import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["node_modules/", "viewer/dist/", "game/dist/", "test-results/", "data/"] },
  js.configs.recommended,
  {
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  ...tseslint.configs.recommended.map((c) => ({ ...c, files: ["game/**/*.ts"] })),
  {
    files: ["game/**/*.ts"],
    languageOptions: { globals: globals.browser },
    rules: { eqeqeq: ["error", "always"], "prefer-const": "error" },
  },
];
