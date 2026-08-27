import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default [
  // Ignore build output — including the vendored WebGPU renderer's own standalone build under
  // src/zarr-viewer/ (its source is TypeScript and isn't linted here anyway).
  { ignores: ['dist', '**/dist', 'src/zarr-viewer/node_modules', '.vite'] },
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '18.3' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/jsx-no-target-blank': 'off',
      // Props are documented via JSDoc (see component file headers) rather than
      // PropTypes throughout this codebase; the prop-types package isn't a dependency.
      'react/prop-types': 'off',
      // `_`-prefixed names mark an intentionally unused binding (matches the
      // convention already used on the TypeScript side under src/zarr-viewer/).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]
