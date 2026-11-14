# Conote 扫描仪

手机拍单据 → 拖角裁边拉直 → 一键变白底黑字 → 多页合成 PDF。单个 `index.html`，可安装成手机 App（PWA），离线可用。

- `index.html` 整个 App
- `scan-core.js` 找边（边线 + 颜色差，带把握分）和增强滤镜，基于 `opencv.js`（OpenCV 4.10，放在仓库里，离线可用）
- `sw.js` 离线缓存；改了 App 记得把里面的 `conote-scan-v4` 版本号加 1
- `manifest.webmanifest` + `icon-*.png` 安装到手机桌面用

网站由 Cloudflare Workers 从 `main` 分支自动发布。
