# 离线包格式（v2）

本文件是离线媒体包格式的规范。`tools/check-format-doc.js` 会解析下文的机器
契约块（```json contract``）并与 `src/client/shared/package-format.js`、实际样例包
逐项比对；文档与实现不一致时检查失败。因此本文件里没有“仅作说明”的版本号或
文件名——每个断言都有对应的脚本校验。

## 1. 两种目录形态

| 形态 | 采用状态 | 位置 | 用途 |
| --- | --- | --- | --- |
| 密封包（`formatVersion: 2`） | **当前采用** | `packages/<name>/` | 离线分发与导入；自含、可校验 |
| 旧式散装清单（`formatVersion: 1`） | **已不再被加载器支持** | `origin-data/media/<course>/manifest.json` | 仅存于源服务器，供在线安装使用，不是离线包 |

`origin-data/` 不是离线包：它是课程源服务器上的散装目录（catalog + 每课清单 +
按 URL 命名的媒体文件）。加载器只把它当在线来源；它不能被当作可导入的离线包，
其中文件也没有内容寻址命名。早期以“散装清单 + URL”方式分发离线材料的做法已
废弃：`formatVersion: 1` 不再被接受（见 §5）。

## 2. 密封包目录布局

```text
<pkg>/
  package.json          描述文件（descriptor），唯一入口
  manifest.json         课程清单（对象 URL 已改写为 objects/<sha256>）
  objects/<sha256>      每个内容摘要一个文件（缓存层）
```

正式资源只有以上三类。包根目录出现其他文件（README、临时文件、源媒体副本）
即为 `LAYOUT_BOUNDARY_VIOLATION`。`objects/` 内的文件名必须恰好是其内容摘要，
这是缓存层与正式资源的边界：对象的身份由摘要决定，而不是由源 URL 决定。

同一段内容可能被多个源 URL 引用（例如两种音轨共用同一初始化段）。对象表按摘要
每摘要一行，`sources` 记录所有映射到它的源 URL；`objects/` 中仍只存一份。

## 3. `package.json`（描述文件）

```json
{
  "format": "offline-media-package",
  "formatVersion": 2,
  "courseId": "course-a",
  "title": "高空作业安全培训",
  "selection": { "quality": "360p", "audio": "en", "subs": ["en", "zh"] },
  "createdAt": "2026-11-18T00:00:00.000Z",
  "manifest": {
    "path": "manifest.json",
    "version": 1,
    "sha256": "<64 hex>",
    "size": 8508
  },
  "objects": [
    {
      "sources": ["media/course-a/v360-init.mp4"],
      "path": "objects/<64 hex>",
      "sha256": "<64 hex>",
      "size": 754
    }
  ]
}
```

规则：

- `format` 必须是 `offline-media-package`。
- `formatVersion` 必填，且必须是受支持版本。缺失即失败（`FORMAT_VERSION_MISSING`），
  **不默认任何版本**。
- `manifest.path` 必须是 `manifest.json`；`manifest.sha256` / `manifest.size` 必须
  与实际清单字节完全一致。
- `manifest.version` 必填，记录清单 schema 版本，且必须等于清单内 `version`。
- 每个对象的 `path` 必须是 `objects/<其 sha256>`，`sha256` 为 64 位小写十六进制，
  `size` 为非负整数。
- 描述文件声明的对象集合与清单引用的对象集合必须**双向完全一致**：清单引用但
  描述未声明 → `OBJECT_UNDECLARED`；描述声明但清单未引用 → `OBJECT_UNREFERENCED`。
- 对象表按摘要唯一；重复摘要 → 描述无效。

## 4. `manifest.json`（清单）

清单与在线安装使用的清单是同一 schema（`version: 1`），区别只在于对象 `url`
已经改写为包内的 `objects/<sha256>`。清单必须声明 `courseId`、`version`，以及
`video` / `audio` / `subtitles` 下的全部引用，每个引用含 `url`、`sha256`、`size`。

## 5. 版本与支持范围

- 包格式采用版本：**2**。
- 加载器支持的包格式版本：**仅 2**。
- 清单 schema 采用版本：**1**；支持的清单版本：**仅 1**。
- `formatVersion: 1`（旧式散装清单）已撤销支持，加载器与检查器都拒绝它。

“缺失即失败、无默认值”的含义：没有 `formatVersion` 或清单没有 `version`
的包一律拒绝（分别对应 `FORMAT_VERSION_MISSING`、`MANIFEST_VERSION_MISSING`），
绝不按某个内置默认版本放行。采用版本必须同时是受支持版本，且受支持版本当前
必须唯一——这条由 `checkAdoptedVersions()` 校验，防止“文档写 v2、加载器默默
接受 v1”。

## 6. 失败代码

| 代码 | 触发条件 |
| --- | --- |
| `DESCRIPTOR_INVALID_JSON` | `package.json` 不是合法 JSON |
| `DESCRIPTOR_INVALID` | 描述字段缺失或类型错误 |
| `FORMAT_VERSION_MISSING` | 缺少 `formatVersion` |
| `FORMAT_VERSION_UNSUPPORTED` | `formatVersion` 不在支持列表 |
| `LAYOUT_BOUNDARY_VIOLATION` | 根目录有非正式文件，或 `path` 不在 `objects/<sha>` |
| `MANIFEST_MISSING` | 缺少 `manifest.json` |
| `MANIFEST_INVALID_JSON` | 清单不是合法 JSON |
| `MANIFEST_SIZE_MISMATCH` | 清单字节数与描述不符 |
| `MANIFEST_DIGEST_MISMATCH` | 清单摘要与描述不符 |
| `MANIFEST_VERSION_MISSING` | 清单缺少 `version` |
| `MANIFEST_VERSION_UNSUPPORTED` | 清单 `version` 不在支持列表 |
| `MANIFEST_VERSION_MISMATCH` | 清单 `version` 与描述记录不一致 |
| `MANIFEST_COURSE_MISMATCH` | 清单 `courseId` 与描述不一致 |
| `OBJECT_UNDECLARED` | 清单引用的对象未在描述中声明 |
| `OBJECT_UNREFERENCED` | 描述声明的对象未被清单引用 |
| `OBJECT_MISSING` | `objects/` 中缺少对象文件 |
| `OBJECT_FILE_UNDECLARED` | `objects/` 中有描述未登记的文件 |
| `OBJECT_SIZE_MISMATCH` | 对象字节数不符 |
| `OBJECT_HASH_MISMATCH` | 对象摘要不符 |

## 7. 加载与恢复流程

加载器（`OfflineEngine.importPackage`）与检查器（`tools/check-package.js`）调用
**同一个** `evaluatePackage()`。因此，检查器判定通过的包，加载器必然接受；检查器
报出的第一条失败代码，就是加载器会抛出的错误码。

导入流程：

1. 读取 `package.json`，按 §3 校验；缺版本立即失败。
2. 读 `manifest.json`，比对描述记录的摘要与大小。
3. 校验清单版本、`courseId`，以及清单与描述的对象覆盖关系。
4. 逐对象读取、比对大小与 SHA-256；任一不符即 `failed`，不提交。
5. 全部通过后按选中组合计算依赖闭包，写入内容寻址缓存并提交为 `ready`。

**恢复步骤**（脚本可校验，见 §8）：

- 包被截断（`OBJECT_SIZE_MISMATCH` / `OBJECT_MISSING`）：重新用
  `npm run packages:build` 生成，不得手工补文件。
- 内容被改动（`OBJECT_HASH_MISMATCH`）：同上，从源媒体重建。
- 旧版清单（`MANIFEST_VERSION_MISSING` / `FORMAT_VERSION_UNSUPPORTED`）：不做
  自动升级；须由 `tools/build-package.js` 从源清单重新打包。
- 根目录混入文件（`LAYOUT_BOUNDARY_VIOLATION`）：移除后重新检查，不要改描述
  去“吸收”这些文件。

## 8. 校验入口

```bash
npm run packages:build        # 生成样例包（含全部损坏变体）
npm run check:packages        # 全部样例包；有效包必须 PASS，变体必须 FAIL
npm run test:format           # 文档契约、样例包、加载器默认值一致性
npm test                      # 单元测试
npm run test:e2e              # 浏览器端导入与断网播放
```

前置条件：`packages:build` 从 `origin-data/` 读取源媒体与清单；`origin-data/`
缺失时先运行 `npm run build:media`，它需要可用于本机的 `ffmpeg-static` 二进制
（在架构不匹配或缺少该二进制的环境中，源媒体需在别处生成后带入，包构建本身
不依赖 ffmpeg）。

`check:packages` 对损坏变体预期失败：命令整体退出码仍为 0，前提是有效包
PASS 且每个损坏变体都以预期失败代码 FAIL；有效包不过或某个变体竟通过都会
使检查失败。变体名与预期代码的对应关系写在文档契约块和
`tools/build-samples.js` 中。

## 9. 界面入口（离线包管理）

启动本地界面：

```bash
npm run dev          # 同时启动界面 :4100 与源服务器 :4101
# 或只启动界面（离线导入不需要源服务器）
node server/app.js
```

打开 `http://localhost:4100`。在“离线包”区域选择包目录（`packages/course-a-360p`
这类包含 `package.json` 的目录），界面会：

1. 本地校验包（无网络请求）。
2. 导入到浏览器内容寻址缓存并显示“可用”。
3. 断网后点击“播放”，由本地缓存经 MSE 播放，并显示标题、可播放范围与缺失
   资源；控制失败反馈回到界面。

```json contract
{
  "packageFormat": "offline-media-package",
  "descriptorFile": "package.json",
  "manifestFile": "manifest.json",
  "objectsDir": "objects",
  "adoptedPackageFormatVersion": 2,
  "supportedPackageFormatVersions": [2],
  "legacyPackageFormatVersion": 1,
  "adoptedManifestVersion": 1,
  "supportedManifestVersions": [1],
  "samplePackages": {
    "valid": ["course-a-360p", "course-b-360p"],
    "damaged": {
      "course-a-360p--truncate-object": "OBJECT_SIZE_MISMATCH",
      "course-a-360p--corrupt-object": "OBJECT_HASH_MISMATCH",
      "course-a-360p--missing-object": "OBJECT_MISSING",
      "course-a-360p--drop-manifest-version": "MANIFEST_VERSION_MISSING",
      "course-a-360p--old-format-v1": "FORMAT_VERSION_UNSUPPORTED",
      "course-a-360p--extra-file": "LAYOUT_BOUNDARY_VIOLATION",
      "course-a-360p--bad-manifest-digest": "MANIFEST_DIGEST_MISMATCH"
    }
  }
}
```
