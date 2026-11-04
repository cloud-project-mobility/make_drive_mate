const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/**',
      'playwright-report/**',
      'test-results/**',
      'backend/**',
      '.tools/**',
      'backend-spring/**',
    ],
  },
]);
