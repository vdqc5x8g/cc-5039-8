// Package contract checker. Runs the exact contract function the browser
// loader uses, so a passing check is evidence the loader will accept the
// package — and a failing check names the precise rule that trips.
//
//   node tools/check-package.js <package-dir> [--json]
//   node tools/check-package.js --all [--json]
//   node tools/check-package.js --doc docs/OFFLINE-PACKAGE-FORMAT.md
//
// Exit codes: 0 = contract holds, 1 = contract violated, 2 = usage error.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_DESCRIPTOR_FILE, OBJECTS_DIR,
  ADOPTED_PACKAGE_FORMAT_VERSION, ADOPTED_MANIFEST_VERSION,
  SUPPORTED_PACKAGE_FORMAT_VERSIONS, SUPPORTED_MANIFEST_VERSIONS,
} from '../src/client/shared/package-format.js';
import { evaluatePackage } from '../src/client/shared/package-contract.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SAMPLE_ROOT = path.join(ROOT, 'packages');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Read a package directory into the same shape the browser loader builds. */
export function loadPackageDir(dir) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`不是目录：${dir}`);
  }
  const byPath = new Map();
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(abs, rel), { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) byPath.set(childRel, fs.readFileSync(path.join(abs, childRel)));
    }
  };
  walk('');
  return {
    byPath,
    readObject: async (rel) => byPath.get(rel) ?? null,
    objectFiles: [...byPath.keys()].filter((p) => p.startsWith(`${OBJECTS_DIR}/`)),
    topLevelEntries: [...byPath.keys()].filter((p) => !p.includes('/')),
  };
}

export async function checkPackageDir(dir) {
  const pkg = loadPackageDir(dir);
  const report = await evaluatePackage({
    descriptorBytes: await pkg.readObject(PACKAGE_DESCRIPTOR_FILE),
    readObject: pkg.readObject,
    sha256,
    objectFiles: pkg.objectFiles,
    topLevelEntries: pkg.topLevelEntries,
  });
  return { dir: path.resolve(dir), ...report };
}

/** The "no default hides an error" check: adopted == the only supported. */
export function checkAdoptedVersions() {
  const problems = [];
  if (!SUPPORTED_PACKAGE_FORMAT_VERSIONS.includes(ADOPTED_PACKAGE_FORMAT_VERSION)) {
    problems.push(`采用版本 ${ADOPTED_PACKAGE_FORMAT_VERSION} 不在支持列表 ${SUPPORTED_PACKAGE_FORMAT_VERSIONS.join(',')} 中`);
  }
  if (SUPPORTED_PACKAGE_FORMAT_VERSIONS.length !== 1) {
    problems.push(`包的采用版本必须唯一，实际支持 ${SUPPORTED_PACKAGE_FORMAT_VERSIONS.join(',')}`);
  }
  if (!SUPPORTED_MANIFEST_VERSIONS.includes(ADOPTED_MANIFEST_VERSION)) {
    problems.push(`采用清单版本 ${ADOPTED_MANIFEST_VERSION} 不在支持列表 ${SUPPORTED_MANIFEST_VERSIONS.join(',')} 中`);
  }
  return problems;
}

export function listSamplePackages() {
  if (!fs.existsSync(SAMPLE_ROOT)) return [];
  return fs.readdirSync(SAMPLE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(SAMPLE_ROOT, d.name))
    .filter((d) => fs.existsSync(path.join(d, PACKAGE_DESCRIPTOR_FILE)));
}

const variantName = (name) => name.split('--').slice(1).join('--');

function printReport(r, { json, expected }) {
  if (json) {
    console.log(JSON.stringify({ ...r, expected }, null, 2));
    return;
  }
  const rel = path.relative(ROOT, r.dir);
  if (expected === 'damaged') {
    // A damaged variant is supposed to fail; passing would be the surprise.
    const state = r.ok ? 'UNEXPECTED-PASS' : 'EXPECTED-FAIL';
    console.log(`${state} ${rel} — ${r.ok ? '损坏变体通过了契约检查' : r.errors[0].code}`);
    return;
  }
  if (r.ok) {
    console.log(`PASS ${rel} — ${r.checkedObjects} 个对象、清单与描述一致（格式 v${r.descriptor.formatVersion}，清单 v${r.manifest.version}）`);
    return;
  }
  console.log(`FAIL ${rel} — ${r.errors.length} 处违背契约`);
  for (const e of r.errors) console.log(`  [${e.code}] ${e.message}`);
}

function main(argv) {
  const json = argv.includes('--json');
  const rest = argv.filter((a) => a !== '--json');
  const all = rest.includes('--all');
  const targets = rest.filter((a) => !a.startsWith('--'));

  if (all) {
    const adopted = checkAdoptedVersions();
    if (adopted.length) {
      for (const p of adopted) console.error(`ADOPTION: ${p}`);
      process.exit(1);
    }
    const pkgs = listSamplePackages();
    if (pkgs.length === 0) {
      console.error('没有样例包，请先运行 npm run packages:build');
      process.exit(1);
    }
    let bad = 0;
    Promise.all(pkgs.map((dir) => checkPackageDir(dir))).then((reports) => {
      let valid = 0;
      let damaged = 0;
      for (const r of reports) {
        const name = path.basename(r.dir);
        const expected = variantName(name) ? 'damaged' : 'valid';
        printReport(r, { json, expected });
        if (expected === 'valid') {
          valid += 1;
          if (!r.ok) bad += 1;
        } else {
          damaged += 1;
          // A damaged variant that passes is a contract hole, not a success.
          if (r.ok) bad += 1;
        }
      }
      if (!json) {
        console.log(`\n有效包 ${valid} 个（全部须 PASS），损坏变体 ${damaged} 个（全部须 FAIL）`);
        console.log(bad === 0 ? '全部符合预期' : `${bad} 个包不符合预期`);
      }
      process.exit(bad === 0 ? 0 : 1);
    });
    return;
  }

  if (targets.length !== 1) {
    console.error('usage: node tools/check-package.js <package-dir> | --all | --doc <file> [--json]');
    process.exit(2);
  }
  checkPackageDir(targets[0]).then((r) => {
    printReport(r, { json, expected: 'valid' });
    process.exit(r.ok ? 0 : 1);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
