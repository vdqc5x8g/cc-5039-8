// Format-document maintenance check.
//
// Parses the ```json contract block in docs/OFFLINE-PACKAGE-FORMAT.md and
// proves every claim against implementation (constants), the generated sample
// packages (valid + damaged), and the loader's own version gate. Any drift
// between doc, constants and samples fails here.
//
//   node tools/check-format-doc.js [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatContract, assertSupportedManifestVersion, FAILURE_CODES,
} from '../src/client/shared/package-format.js';
import { checkPackageDir, listSamplePackages, checkAdoptedVersions } from './check-package.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DOC = path.join(ROOT, 'docs', 'OFFLINE-PACKAGE-FORMAT.md');

export function parseContractBlock(markdown) {
  const match = markdown.match(/```json contract\n([\s\S]*?)\n```/);
  if (!match) throw new Error('文档缺少 ```json contract 契约块');
  return JSON.parse(match[1]);
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export async function checkFormatDoc({ samples } = {}) {
  const problems = [];
  const fail = (msg) => problems.push(msg);

  if (!fs.existsSync(DOC)) {
    return { ok: false, problems: [`缺少文档 ${path.relative(ROOT, DOC)}`] };
  }
  const markdown = fs.readFileSync(DOC, 'utf8');
  let doc;
  try {
    doc = parseContractBlock(markdown);
  } catch (err) {
    return { ok: false, problems: [err.message] };
  }

  // 1. Document vs implementation constants.
  const impl = formatContract();
  for (const key of [
    'packageFormat', 'descriptorFile', 'manifestFile', 'objectsDir',
    'adoptedPackageFormatVersion', 'supportedPackageFormatVersions',
    'legacyPackageFormatVersion', 'adoptedManifestVersion', 'supportedManifestVersions',
  ]) {
    if (!sameJson(doc[key], impl[key])) {
      fail(`文档 ${key}=${JSON.stringify(doc[key])} 与实现 ${JSON.stringify(impl[key])} 不一致`);
    }
  }

  // 2. Adopted version is the single supported version (no default hides an error).
  for (const p of checkAdoptedVersions()) fail(p);
  if (doc.adoptedPackageFormatVersion !== impl.adoptedPackageFormatVersion) {
    fail('文档采用版本与实现不一致');
  }

  // 3. Every failure code the doc's damaged-sample table promises exists.
  const knownCodes = new Set(impl.failureCodes);
  for (const [name, code] of Object.entries(doc.samplePackages?.damaged ?? {})) {
    if (!knownCodes.has(code)) fail(`变体 ${name} 承诺的失败代码 ${code} 不是实现中的失败代码`);
  }

  // 4. Sample packages on disk match the document exactly, and produce the
  //    promised verdicts through the same checker the loader uses.
  const dirs = samples ?? listSamplePackages();
  const byName = new Map(dirs.map((d) => [path.basename(d), d]));
  const expectedValid = doc.samplePackages?.valid ?? [];
  const expectedDamaged = doc.samplePackages?.damaged ?? {};

  for (const name of expectedValid) {
    if (!byName.has(name)) {
      fail(`文档列出的有效样例包不存在：${name}`);
      continue;
    }
    const report = await checkPackageDir(byName.get(name));
    if (!report.ok) {
      fail(`有效样例包 ${name} 未通过契约检查：${report.errors.map((e) => e.code).join(', ')}`);
    } else if (!doc.supportedPackageFormatVersions.includes(report.descriptor.formatVersion)) {
      fail(`样例包 ${name} 的格式版本 ${report.descriptor.formatVersion} 不在文档支持列表`);
    }
  }

  for (const [name, code] of Object.entries(expectedDamaged)) {
    if (!byName.has(name)) {
      fail(`文档列出的损坏变体不存在：${name}`);
      continue;
    }
    const report = await checkPackageDir(byName.get(name));
    if (report.ok) {
      fail(`损坏变体 ${name} 竟然通过了契约检查`);
    } else if (!report.errors.some((e) => e.code === code)) {
      fail(`损坏变体 ${name} 期望 ${code}，实际 ${report.errors.map((e) => e.code).join(', ')}`);
    }
  }

  const extra = [...byName.keys()].filter(
    (n) => !expectedValid.includes(n) && !(n in expectedDamaged),
  );
  for (const name of extra) fail(`样例包 ${name} 未在文档契约块中登记`);

  // 5. The loader's version gate agrees with the document, including that a
  //    missing version is rejected (never defaulted).
  const probe = (manifest, label, wantCode) => {
    try {
      assertSupportedManifestVersion(manifest);
      fail(`加载器接受了${label}`);
    } catch (err) {
      if (err.code !== wantCode) fail(`${label} 期望 ${wantCode}，实际 ${err.code}`);
    }
  };
  probe({ courseId: 'x' }, '缺少 version 的清单', FAILURE_CODES.MANIFEST_VERSION_MISSING);
  const unsupportedManifest = doc.supportedManifestVersions.includes(99) ? 100 : 99;
  probe({ courseId: 'x', version: unsupportedManifest }, '不支持的清单版本', FAILURE_CODES.MANIFEST_VERSION_UNSUPPORTED);
  for (const v of doc.supportedManifestVersions) {
    try {
      assertSupportedManifestVersion({ courseId: 'x', version: v });
    } catch (err) {
      fail(`加载器拒绝了文档声明支持的清单版本 ${v}：${err.message}`);
    }
  }

  // 6. Document recovery/verification commands must exist in package.json and
  //    (for direct node invocations) point at a real file.
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts ?? {};
  const requiredCommands = ['npm run packages:build', 'npm run check:packages', 'npm run test:format'];
  for (const cmd of requiredCommands) {
    if (!markdown.includes(cmd)) fail(`文档缺少校验/恢复命令：${cmd}`);
    const scriptName = cmd.replace('npm run ', '');
    if (!Object.hasOwn(scripts, scriptName)) fail(`文档引用的 npm 脚本不存在：${scriptName}`);
  }
  for (const match of markdown.matchAll(/node (tools\/[\w.-]+\.js)/g)) {
    if (!fs.existsSync(path.join(ROOT, match[1]))) fail(`文档引用的脚本不存在：${match[1]}`);
  }
  // The documented UI entry points must exist too.
  for (const match of markdown.matchAll(/node (server\/[\w.-]+\.js)/g)) {
    if (!fs.existsSync(path.join(ROOT, match[1]))) fail(`文档引用的服务脚本不存在：${match[1]}`);
  }

  return { ok: problems.length === 0, problems, document: path.relative(ROOT, DOC) };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const json = process.argv.includes('--json');
  checkFormatDoc().then((result) => {
    if (json) {
      console.log(JSON.stringify(result, null, 2));
    } else if (result.ok) {
      console.log(`PASS ${result.document} — 契约块、样例包与加载器版本门一致`);
    } else {
      console.log(`FAIL ${result.document} — ${result.problems.length} 处不一致`);
      for (const p of result.problems) console.log(`  - ${p}`);
    }
    process.exit(result.ok ? 0 : 1);
  });
}
