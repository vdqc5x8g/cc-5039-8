import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export default async function globalSetup() {
  if (!fs.existsSync('origin-data/catalog.json')) {
    console.log('[global-setup] origin-data missing, building media library…');
    execFileSync(process.execPath, ['tools/build-media.js'], { stdio: 'inherit' });
  }
}
