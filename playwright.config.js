import { defineConfig } from '@playwright/test';

const SYS_LIBS = [
  '/workspace/.syslibs/root/usr/lib/aarch64-linux-gnu',
  '/workspace/.syslibs/root/lib/aarch64-linux-gnu',
].join(':');

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.js',
  use: {
    baseURL: 'http://localhost:4100',
    launchOptions: {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: `${SYS_LIBS}:${process.env.LD_LIBRARY_PATH ?? ''}`,
      },
    },
  },
  webServer: [
    {
      command: 'node server/origin.js',
      url: 'http://localhost:4101/catalog.json',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'node server/app.js',
      url: 'http://localhost:4100/index.html',
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
