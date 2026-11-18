import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export default async function globalSetup() {
  if (!fs.existsSync('origin-data/catalog.json')) {
    console.log('[global-setup] origin-data missing, building media library…');
    execFileSync(process.execPath, ['tools/build-media.js'], { stdio: 'inherit' });
  }
  // Sample packages are generated from origin-data; regenerate when absent.
  const sample = 'packages/course-a-360p/package.json';
  if (!fs.existsSync(sample)) {
    console.log('[global-setup] sample packages missing, building…');
    execFileSync(process.execPath, ['tools/build-samples.js'], { stdio: 'inherit' });
  }
}
