import globals from "globals";
import pluginJs from "@eslint/js";
import prettierPlugin from "eslint-plugin-prettier";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "build/**"],
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...pluginJs.configs.recommended.rules,
      "prettier/prettier": "error",
    },
  },
];
