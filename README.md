# 外场培训 · 离线媒体

离线课程媒体的打包、校验与断网播放。包格式规范见
[`docs/OFFLINE-PACKAGE-FORMAT.md`](docs/OFFLINE-PACKAGE-FORMAT.md)。

## 快速开始

```bash
npm install
npm run build:media        # 生成 origin-data/（源媒体，需 ffmpeg-static）
npm run packages:build     # 生成 packages/（有效样例包 + 损坏变体）
npm run dev                # 界面 http://localhost:4100 ，源服务器 :4101
```

打开 <http://localhost:4100>，在“离线包”区域选择 `packages/course-a-360p`
目录即可校验、导入并断网播放。只验证离线导入与播放时，也可以只启动界面：

```bash
node server/app.js
```

## 校验

```bash
npm test                   # 单元测试（契约、闭包、淘汰策略）
npm run test:format        # 生成样例包 + 契约检查 + 文档一致性检查
npm run test:e2e           # Playwright：在线安装、离线导入、断网播放、损坏包
```

`npm run test:format` 是包格式文档的维护检查：文档中的 ```json contract```
块、实现常量、样例包实际判定，以及加载器的版本门必须三者一致。

## 目录

- `src/client/engine/` — 内容寻址缓存、安装、校验、MSE 播放
- `src/client/shared/` — 包格式常量与契约评估（加载器与工具共用）
- `tools/build-media.js` — 生成源媒体与课程清单（会清理旧的包）
- `tools/build-samples.js` — 生成样例包与损坏变体
- `tools/check-package.js` — 包契约检查器
- `tools/check-format-doc.js` — 文档维护检查
- `server/` — 界面（4100）与源服务器（4101）
