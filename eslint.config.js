import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'playwright-report', 'test-results'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Media scripts run in Node, not the browser; code they hand to page.evaluate declares
    // its browser globals itself.
    files: ['media/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    // The simulation must stay portable: no three, no react, no browser globals.
    // This rule is the enforcement of the architectural boundary in PRD.md.
    files: ['src/sim/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: ['three', 'three/*', 'react', 'react/*', '@react-three/*', 'zustand'],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'src/sim must not touch the DOM.' },
        { name: 'document', message: 'src/sim must not touch the DOM.' },
        { name: 'localStorage', message: 'src/sim must not touch storage.' },
      ],
      // Determinism is a hard requirement, not a convention: use rng.ts.
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG in sim/rng.ts.' },
        { object: 'Date', property: 'now', message: 'The simulation has no wall clock.' },
      ],
    },
  },
);
