import { defineConfig, devices } from '@playwright/test';
const webPort = Number(process.env.DRIVEMATE_WEB_TEST_PORT || 8081);
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60000,
  expect: { timeout: 10000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 3,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox'],
    },
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command:
      process.env.DRIVEMATE_WEB_STATIC === '1'
        ? `node scripts/serve-web-test.cjs ${webPort}`
        : `npm run web -- --port ${webPort} --localhost`,
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: !process.env.CI && !process.env.DRIVEMATE_WEB_TEST_PORT,
    timeout: 180000,
    env: { CI: '1', EXPO_NO_TELEMETRY: '1' },
  },
});
