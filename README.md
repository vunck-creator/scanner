# 文件扫描仪

手机拍单据 → 拖角裁边拉直 → 一键变白底黑字 → 多页合成 PDF。单个 `index.html`，可安装成手机 App（PWA），离线可用。

- `index.html` 整个 App
- `scan-core.js` 找边（边线 + 颜色差，带把握分）和增强滤镜，基于 `opencv.js`（OpenCV 4.10，放在仓库里，离线可用）
- `sw.js` 离线缓存；改了 App 记得把里面的 `conote-scan-vN` 加 1，同时把 index.html 标题下的版本号（`.ver`）改成一样的 vN 和日期，手机上一看就知道 Cloudflare 更新了没
- `manifest.webmanifest` + `icon-*.png` 安装到手机桌面用

网站由 Cloudflare Workers 从 `main` 分支自动发布。
