import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['packages/*/src/**/*.{test,spec}.ts'],
    // v0.12.4: arm the fail-closed guard in core's keychain `defaultExec`.
    // A unit test that forgets to inject a fake keychain otherwise spawns
    // PowerShell + Add-Type on Windows and flakes out at vitest's 5s
    // timeout. Both variables are required by the guard so a stray
    // variable in a real user's shell cannot disable their keychain.
    // The macOS integration block in keychain.spec.ts opts out explicitly.
    env: { NODE_ENV: 'test', AIFTP_TEST_NO_REAL_KEYCHAIN: '1' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.{test,spec}.ts', '**/index.ts', '**/types.ts', '**/__fixtures__/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
