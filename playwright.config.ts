import { defineConfig, devices } from '@playwright/test';

const PORT = 5199;

/**
 * End-to-end configuration.
 *
 * WebGL in headless Chromium falls back to SwiftShader, which needs to be enabled
 * explicitly. Without these flags the canvas mounts but never renders, and the suite would
 * pass while showing a blank scene.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // The trailer is a capture job, not a behaviour check. `npm run render:trailer` opts in.
  testIgnore: process.env.RENDER_TRAILER === '1' ? [] : [/marketing\.spec\.ts/],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    launchOptions: {
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
