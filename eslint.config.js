// Lint: pega nome não declarado (dependência esquecida ao passar entre módulos), variável sem uso e erros comuns.
// Rodar: npm run lint  (o deploy só segue com lint e testes limpos)
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'public/**', 'docs/**', 'backups/**', 'scratch/**'] },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // JS do painel: roda no navegador, script comum (funções chamadas por onclick no HTML)
    files: ['views/painel.client.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': 'off' },
  },
];
