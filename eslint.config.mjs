import js from "@eslint/js";
import tseslint from "typescript-eslint";
import next from "@next/eslint-plugin-next";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/coverage/**", "**/next-env.d.ts"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    // Test code indexes into query results it has just seeded; non-null assertions are acceptable there only.
    files: ["**/*.test.ts", "**/tests/**/*.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "@next/next": next },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
      "@next/next/no-html-link-for-pages": "off", // app router only; no pages/ dir
    },
  },
);
