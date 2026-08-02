import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      // Generated from .proto; regenerate rather than edit.
      'packages/protocol/src/gen/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      // Type information, for the four rules below. Not the full
      // `recommendedTypeChecked` preset: that adds a large number of unrelated
      // rules at once, and the point here is the promise-lifecycle family.
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      /**
       * The promise-lifecycle rules, and the reason this config needs type
       * information at all.
       *
       * Three separate ways the worker could end up alive, healthy and
       * monitoring nothing were all the same mistake: a promise nobody was
       * waiting on. `void somethingAsync()` with no catch, an `await` missing
       * before a call whose rejection then had nowhere to go, a `finally` that
       * was not one. None of it is visible without types, which is why none of
       * it was caught.
       */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      // `require-await` is deliberately not enabled. It found eight sites, all
      // of them Fastify handlers and test callbacks written `async` for
      // uniformity with the sixty around them that do await — a style, not a
      // defect. Making those eight sync is churn that the next added `await`
      // reverses, and the noise would be paid on every future handler.

      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    // §5.2: no SQL string concatenation anywhere. Every SQL statement must be a
    // plain string literal with `mssql` request parameters supplying values.
    // This is the codified half of the rule; the review checklist is the other.
    files: ['packages/worker/**/*.ts', 'packages/server/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.property.name=/^(query|batch|execute)$/] > TemplateLiteral:has(TemplateLiteral > *.expressions)',
          message:
            'SQL must not be built by interpolation. Use a static string literal and bind values with request.input(...).',
        },
        {
          selector:
            'CallExpression[callee.property.name=/^(query|batch|execute)$/] > BinaryExpression[operator="+"]',
          message:
            'SQL must not be built by concatenation. Use a static string literal and bind values with request.input(...).',
        },
      ],
    },
  },
  {
    // The dashboard is the only package with hooks. `rules-of-hooks` catches a
    // hook called conditionally or outside a component; `exhaustive-deps`
    // catches an effect that reads a value it did not list as a dependency —
    // the same class of bug as CapabilityEditor's stale `useState` initializer
    // (fixed by an explicit resync `useEffect`), just easier to miss on review
    // than the promise-lifecycle bugs the type-aware rules above catch.
    files: ['packages/dashboard/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
  {
    // This file, and any other plain JS. Type-aware linting needs every linted
    // file to belong to a tsconfig, and putting a `.js` config file in one
    // would mean turning on `allowJs` across the repository just to type-check
    // the file that configures the checking. Last, because flat config is
    // order-dependent and this has to win.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { parserOptions: { projectService: false, project: false } },
  },
);
