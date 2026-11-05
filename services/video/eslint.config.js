// ESLint flat config (ADR 0001): typescript-eslint type-aware rules.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['contract/dist/**', 'src/contract/**', 'migrations/**'] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { returns: false, arguments: false } }],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.test.ts'],
    rules: { '@typescript-eslint/no-unsafe-member-access': 'off', '@typescript-eslint/no-unsafe-assignment': 'off' },
  },
);
