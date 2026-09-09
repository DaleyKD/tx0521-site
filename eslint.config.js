// @ts-check
import js from '@eslint/js';
import eslintPluginAstro from 'eslint-plugin-astro';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  js.configs.recommended,
  ...eslintPluginAstro.configs.recommended,
  {
    ignores: ['dist/**', '.astro/**', 'node_modules/**'],
  },
  {
    // Astro component frontmatter uses TS syntax (interfaces, type imports).
    // Type-only signature parameters (e.g. `(href?: string) => boolean`) aren't
    // real unused variables, so swap the base rule for the TS-aware one.
    files: ['**/*.astro'],
    plugins: { '@typescript-eslint': tsPlugin },
    languageOptions: {
      parserOptions: { parser: tsParser },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'error',
    },
  },
  {
    // The Worker runs in Cloudflare's Workers runtime, which shares the
    // Fetch/Cache API surface with Service Workers.
    files: ['worker/**/*.js'],
    languageOptions: {
      globals: globals.serviceworker,
    },
  },
];
