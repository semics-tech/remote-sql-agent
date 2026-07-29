import js from '@eslint/js';
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
    },
    rules: {
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
    files: ['**/*.test.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
