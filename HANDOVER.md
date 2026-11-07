# 交接说明 — 音乐弹珠 Music Marbles

> 交接时间：2026-11-07（PST）  
> 仓库：<https://github.com/longguanhong0755/music-marbles>  
> 分支：`master`（功能基线 `b9b2863`；交接记录提交见 `git log`）  
> 线上地址：<https://longguanhong0755.github.io/music-marbles/>  
> 本机目录：`/root/MusicMarbles`

## 1. 当前状态（先看这段）

| 项目 | 交接时状态 |
| --- | --- |
| 工作区 | 与 `origin/master` 同步，没有未提交的源码改动 |
| 本地服务 | `node server/index.js` 已在 `0.0.0.0:8080` 运行（交接时 PID 3360307） |
| 自动化测试 | `npm test` 通过：引擎全曲目/多种子通过，来源检查 8 项通过 |
| 浏览器冒烟 | 通过：首页四首内置曲目、生成观看链接、播放进度、控制台无报错 |
| GitHub 仓库 | 与远端同步，无 open issue / PR / release |
| GitHub Actions | 交接时发现被关闭；已重新启用（`enabled=true`，允许所有 action）。历史 Pages workflow run 仍显示 queued，属于陈旧队列，可忽略 |
| GitHub Pages | 交接时发现被关闭，线上 404；已重新启用。workflow 部署队列卡住后改为 legacy 构建（source `master` /），线上已恢复 200 |
| 线上资源 | 已确认首页、观看页、`builtins/manifest.json`、`notes.json`、`scripts/watch.js`、`styles/watch.css` 均为 200 |

> 结论：代码和本地功能健康。交接时真正的问题是 GitHub 侧的 Pages / Actions 被关闭，不是应用代码坏了；两个开关已恢复，Pages 已用 legacy 构建重新上线。

## 2. 这个项目是什么

把一首歌变成一条可分享的弹珠轨道：

1. 浏览器在本地解码音频、重采样，`scripts/onset-worker.js` 做谱通量起点检测和 FFT 取音高。
2. `scripts/engine.js` 把音符时间变成横杆，用 DFS 折叠出一条紧凑路径；弹珠以 400 units/s 匀速前进，每个音符恰好撞一根横杆。
3. `scripts/scene.js` 把同一场景渲染到屏幕和导出画布；`scripts/walls.js` 生成可选的黑色墙壁房间。
4. `scripts/watch.js` 负责播放、1 秒加速、换种子、黑/白背景、10 分钟倒计时和视频导出。
5. `server/index.js` 提供上传、曲库代理、分享链接、音频裁剪、TTL 清理和 ffmpeg 视频封装。
6. 没有服务端时，页面自动退化为纯静态模式，只提供 `builtins/` 里的四首内置曲目，并在浏览器内导出 MP4。

## 3. 代码地图

| 路径 | 作用 |
| --- | --- |
| `index.html` | 制作页：上传 / 网络曲库 / 内置曲目三个来源，墙壁开关，生成链接 |
| `watch.html` | 观看页：画布、播放栏、背景切换、分享、延长、视频导出弹窗 |
| `scripts/landing.js` | 制作页逻辑：解码、重采样、调用 onset worker、上传、生成链接、曲库搜索 |
| `scripts/onset-worker.js` | 无依赖的音符起点 + 音高识别 Worker |
| `scripts/engine.js` | 折叠路径生成、恒速模拟、种子、intro 加速段 |
| `scripts/walls.js` | 墙壁房间并集、墙块和墙根绘制 |
| `scripts/scene.js` | 共用场景渲染、横杆 sprite 缓存、黑/白背景 |
| `scripts/watch.js` | 观看页全部交互；WebCodecs 离线导出、MediaRecorder 回退、静态模式 |
| `scripts/vendor/mp4-muxer.js` | 浏览器端 MP4 封装（MIT） |
| `server/index.js` | Express 服务、上传、TTL、ffmpeg 转码/封装、分享路由 |
| `server/sources.js` | Incompetech 目录、纯器乐过滤、中文关键词、HMAC 音频令牌、URL 白名单 |
| `builtins/` | 四首内置曲目的 `notes.json` / `score.json` / `audio.mp3` 和清单 |
| `music/music.js` | 原项目内置 MIDI 数据，供构建和引擎校验使用 |
| `tools/verify_engine.js` | 引擎离线校验（布局、碰撞、恒速、种子、intro） |
| `tools/verify_sources.js` | 曲库层离线校验（翻译、过滤、排序、白名单、令牌） |
| `tools/build_builtins.js` | 从 MIDI 重建内置曲目，需要 Python 3 + NumPy + ffmpeg |
| `data/` | 运行时上传/导出/临时文件，已被 `.gitignore` 忽略，10 分钟 TTL |
| `samples/` | 历史人工验收截图/测试视频，未跟踪，本次已加入 `.gitignore` |
| `scripts/main.js`、`scripts/wasm_api.js`、`scripts/transcribe-worker.js`、`wasm/`、`vendor/basic-pitch/` | 原项目/实验路径，当前应用不加载；保留作参考，不要误当成主链路 |

## 4. 本地运行与验证

环境要求：Node.js 18+（本机 22.23.1）、npm、`PATH` 里有 `ffmpeg`。本机还有 `/usr/bin/google-chrome`，可用于浏览器冒烟。

```bash
cd /root/MusicMarbles
npm install
npm start
# http://localhost:8080/
```

当前已有一个服务在 8080；改完 `server/` 代码后需要重启才会生效：

```bash
pkill -f 'node server/index.js'
nohup npm start >/tmp/music-marbles.log 2>&1 &
```

测试：

```bash
npm test          # 引擎 + 曲库，两层都跑
npm run verify    # 只跑引擎
```

配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 监听端口 |
| `CONTENT_TTL_MS` | `600000` | 上传轨道/导出视频保留毫秒数，最低 60000 |
| `PUBLIC_BASE_URL` | 请求的 host | 生成分享链接时使用的公开地址；放到反向代理后面时必须设置 |

## 5. 数据、缓存和过期规则

- 上传轨道在 `data/tracks/<id>/`，导出视频在 `data/exports/<id>/`，临时文件在 `data/tmp/`。
- 服务端每 10 秒清扫一次；访问过期资源时也会立即删除。默认保留 10 分钟。
- 内置曲目不受 TTL 影响，永久保留。
- Incompetech 目录在内存缓存 12 小时；音频不落盘，由服务端带 Range 代理。
- 音频令牌有效期 30 分钟，HMAC secret 在 `create_source_service()` 时随机生成。**服务重启会让已经发出去的曲库音频令牌全部失效**，用户需要重新搜索。
- 曲库只允许 `incompetech.com` 的 `/music/royalty-free/mp3-royaltyfree/` 路径，客户端不能拿任意 URL 让服务器抓取。

## 6. 本次交接实际验证过的内容

```text
npm test
  PASS  四首内置曲目 × 多种子布局 / 命中 / 恒速 / 间距
  PASS  intro 1 秒加速段
  all tracks passed
  source checks: 8 passed
```

本机接口：

- `GET /api/health` → `{"ok":true}`
- `GET /api/builtins` → 四首曲目
- `GET /builtins/mozart-rondo/audio.mp3` → 200，1,832,585 bytes
- `GET /api/source/search?q=piano&page=1` → 200，382 首命中

浏览器冒烟（Chrome headless，1280×900）：

- 首页正常加载，四张内置曲目卡片（土耳其进行曲 / 山魔王的宫殿 / 演艺人 / 糖梅仙子之舞）。
- 选中并生成：`/watch.html?id=builtin-mozart-rondo&walls=1&seed=...`。
- 观看页标题、来源、播放按钮就绪；点击播放 2.5 秒后进度到 `0:02 / 1:17`，暂停图标状态正确。
- 无 console error、pageerror 或 requestfailed。

历史参考：2026-11-02 曾在 headless Chrome 里完整导出 9:16 720p《演艺人》，约 219 秒、19.5 MB；耗时主要在 `readback`/编码队列，不是引擎或绘制。这个数据只用于判断导出性能，不建议当回归基准。

## 7. 已知问题与风险

1. **GitHub Pages / Actions 曾被关闭（本次已恢复）。** 线上 404 的直接原因不是构建失败，而是 Pages 未启用；同时仓库 Actions 权限也是 `enabled=false`。恢复后旧的 Pages workflow 重跑一直停在 `queued`，因此本次把 Pages 改为 **legacy 构建**（source `master` /），由 GitHub 内部 builder 直接发布，线上已 200。这个 legacy 构建不依赖 Actions；如果以后要切回 workflow，先确认旧的 `pages build and deployment` run 已结束或被清理。
2. **没有账号、限流和公网防护。** 项目定位是本机/可信局域网；不要直接把 8080 暴露到公网。上传内容会写 `data/`。
3. **Incompetech 是单点外部依赖。** 目录或音频源不可达时，网络曲库会失败；本地上传和内置曲目不受影响。公开分享要保留 Kevin MacLeod / incompetech.com 署名（CC BY 4.0）。
4. **导出性能因浏览器/机器差异很大。** WebCodecs 软件编码、`readback` 和编码队列都可能成为瓶颈；长曲在无硬件编码的机器上可能比实时播放更久。快速导出（720p）能明显减小文件。
5. **自动化测试覆盖有边界。** `npm test` 只覆盖引擎和曲库，不覆盖 Express 上传、ffmpeg、真实浏览器播放/导出；这些仍靠人工冒烟。
6. **工作区有历史验收产物。** 交接时 `samples/` 35 MB / 106 个截图和视频，`data/` 还有几十 MB 过期导出（会被 TTL 清掉）。`samples/` 已加入 `.gitignore`，是否保留由接手人决定。
7. **静态模式和 Pages 子路径依赖一个约定。** 当前 Pages 使用 legacy 构建，`builtins/manifest.json` 里的路径以 `/builtins/...` 开头；`watch.js` / `landing.js` 会先去掉开头的 `/` 再用 `document.baseURI` 解析。不要把这个处理删掉，否则 Pages 子路径会 404。
8. **静态资源靠手写 `?v=` 破缓存。** 改 `styles/*.css` 或 `scripts/*.js` 后，要同步改 `index.html` / `watch.html` 里的版本号，否则浏览器可能继续用旧文件。
9. **仓库里没有 `.github/workflows`。** 当前 Pages 使用 Settings 里的 legacy 构建；Actions 里还留着旧的 dynamic `pages build and deployment` run。不要靠删 workflow 文件控制 Pages，去 `Settings → Pages` 查看构建方式和状态。
10. **令牌安全。** 本次交接使用的 GitHub token 不应写进仓库、脚本或 `.git-credentials`；交接完成后建议在 GitHub 设置里轮换/撤销。

## 8. 接手后的建议顺序

1. **先确认线上。** 打开 <https://longguanhong0755.github.io/music-marbles/>，确认 200；再打开一首内置曲目，确认 `builtins/manifest.json`、`notes.json`、`audio.mp3` 都是 200。若仍是 404，检查 `Settings → Pages` 是否仍为 legacy / `master` / `/`，以及 latest Pages build 的状态。
2. **再跑一次本机回归。** `npm test` + 第 6 节的浏览器冒烟；如果改过 `server/`，重启 8080。
3. **决定是否清理。** `samples/` 可移到外部归档或删除；`data/` 交给 TTL 自动清理即可。
4. **补一条最小浏览器 CI（可选）。** 用 Playwright/Puppeteer 跑“首页 → 内置曲目 → 观看页 → 播放 2 秒 → 无 console error”，比人工截图更能防止回归。注意 Actions 是本次手动恢复的，队列里还有历史 Pages run，先确认额度和策略。
5. **要公网部署时再加防护。** 至少加反向代理、上传限流、鉴权和持久化磁盘；当前实现不适合直接公网暴露。
6. **性能优化再看导出。** 优先确认目标浏览器的 `VideoEncoder` 硬件支持，再决定是否调整 `readback`、sprite 缓存或编码队列；不要为了跑分牺牲 30 fps 和音画同步。

## 9. 交接检查清单

- [x] 工作区与远端同步，确认没有漏提交的源码
- [x] `npm test` 通过
- [x] 本地 8080 健康检查、内置音频、曲库搜索通过
- [x] 浏览器冒烟通过（首页 / 生成链接 / 观看页播放）
- [x] 恢复 GitHub Actions（仓库级）
- [x] 恢复 GitHub Pages（legacy 构建）并确认线上 200
- [x] 写入交接文档，忽略本地 `samples/`
- [x] 确认线上 Pages 部署完成且首页/观看页/子路径资源 200
- [ ] 轮换本次交接使用的 GitHub token
- [ ] 决定 `samples/` 和历史 `data/` 的保留策略

## 10. 常用命令速查

```bash
# 本地服务
npm start
curl -s http://127.0.0.1:8080/api/health

# 测试
npm test

# 重建全部内置曲目（需要 python3 + numpy + ffmpeg）
npm run build:builtins

# 只重建一首
node tools/build_builtins.js sugar-plum

# 查看远端
git fetch origin
git log --oneline -5 origin/master

# 发布（有权限的 token 通过环境变量提供，不要把 token 写进 remote URL）
git push origin master
```
