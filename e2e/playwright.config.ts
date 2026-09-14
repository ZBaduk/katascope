import { defineConfig } from '@playwright/test';

/**
 * Electron-only. Playwright drives the app through its own Electron binary, so
 * no browsers need downloading -- `npx playwright install` is not a prerequisite
 * here or in CI.
 *
 * The app must be built first: these tests launch `apps/desktop/dist/main` and
 * load the renderer from `packages/ui/dist`. Run `npm run test:e2e` from the
 * repo root, which builds and then runs.
 */
export default defineConfig({
  testDir: './tests',
  // Electron launches are heavy and the app holds a single-instance lock, so
  // one at a time.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure' },
});
