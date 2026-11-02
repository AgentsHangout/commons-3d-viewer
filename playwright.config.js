import { defineConfig } from '@playwright/test';

/**
 * Headless Chromium on GitHub Actions has no GPU. These flags opt into
 * ANGLE + SwiftShader (software WebGL). chrome-headless-shell is skipped
 * via `channel: 'chromium'` so the full Chromium binary is used.
 *
 * @see https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md
 */
const softwareWebGLArgs = [
  '--ignore-gpu-blocklist',
  '--enable-unsafe-swiftshader',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--disable-dev-shm-usage'
];

export default defineConfig({
  testDir: 'tests',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1280, height: 720 },
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: softwareWebGLArgs
    }
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Full Chromium new-headless, not chrome-headless-shell (no WebGL stack).
        channel: 'chromium'
      }
    }
  ],
  webServer: {
    command: 'npx vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000
  }
});
