# Custom Badge / Badge Studio

独立的账号头像 mod。玩家用三种颜色、两个填色图层绘制自己的 Badge，服务器将几何图形编译为原生的 `type: { path1, path2 }` 格式。不依赖赛季 mod 或饰品库存，不启动 tick 任务，不修改地图、建筑、代码、Memory、GCL 或排行榜。

## 第一版功能

- 100×100 画布，原生 Badge 圆形裁切；32 / 64 / 128 像素预览。
- 圆 / 椭圆、矩形、三角形、3–16 顶点的简单多边形。
- 鼠标 / 触摸拖动、数值调整位置和尺寸、旋转、水平 / 垂直镜像、切换图层。
- 三色选择、复制 / 删除图形、新建、撤销 / 重做。
- 私人草稿与已佩戴头像分离；保存草稿不改游戏头像；保存并应用才发布图案。
- 重新载入、恢复默认头像；多窗口版本冲突返回 409，不覆盖新版本。
- 本服用户名 / 密码登录；已有同源浏览器登录 token；本服 Steam OpenID 弹窗。
- 管理员按玩家账号 ID 查询、重置、禁用 / 解禁自定义头像。
- 原版 24 种 Badge、饰品授予的 Badge 继续可用。

不支持照片上传、SVG/XML 文件、任意路径字符串、文字、外链或自由画笔。图层 2 始终覆盖图层 1；同层图形合并填色，不提供任意对象层叠、透明度、描边或挖空。

## 部署

在现有 `mods` 列表中**追加**，不要覆盖当前的赛季和其他 mod：

```yaml
mods:
  # 原有 mod 保持不变
  - xxscreeps/mods/custom-badge

customBadge:
  enabled: true
  maxShapes: 32
  maxPathLength: 32768
  saveCooldownSeconds: 10
  adminUsers: [] # 填账号 ID，不是用户名；空数组表示没有管理权限
```

允许范围：`maxShapes` 1–64；`maxPathLength` 1024–131072（两个路径合计字符数）；`saveCooldownSeconds` 0–3600。发布、保存草稿共享账号级保存冷却。恢复默认和管理员操作不受冷却限制。

源码部署需先执行仓库的正常构建，再重启加载该 mod 的后端。新页面及浏览器 JS 都从编译产物提供，不需要独立前端服务或新依赖。**不需要重建地图、初始化赛季或迁移旧 Badge。**本次实现不会自动修改部署配置。

页面路径：`/custom-badge/`。重新连接客户端后，服务器菜单增加 **Badge Studio**。

### 登录与入口

- 本服密码登录复用 `xxscreeps/mods/backend/password` 的 `/api/auth/signin`；不创建第二套账号或密码库。只有 Steam 账号且未设置本服密码的玩家应使用 Steam 登录。
- Steam 登录需已加载 `xxscreeps/mods/backend/steam` 且正常配置 `backend.steamApiKey`。编辑器只接受**当前登录弹窗**、**同源回调**发来的 token，再访问本服接口校验身份；不会信任消息里的用户名。
- Steam 桌面客户端打开的独立页面**不能假定继承客户端登录**，需要在页面登录。未登录可本地设计，不能读取私人草稿或保存。
- 同源网页客户端可读取原有 `localStorage.auth`；编辑器自身仅在 `sessionStorage` 保存 token，不保存密码、不把 token 放进 URL、不改写其他游戏窗口的登录状态。编辑时每 45 秒刷新短期 token；后台长时间挂起过期后重新登录即可，当前内存草稿仍在。
- 如果客户端与后端不同源，尤其 Steam 客户端，请将现有 `backend.assetBaseUrl` 配置为玩家可访问的后端 HTTPS 地址。菜单链接会使用该前缀。例如 `https://your-server.example`。同源、根路径部署可留空。
- 同源反向代理前缀也支持；页面使用相对模块 / API 地址。Steam OpenID 的回调路径由原有 Steam mod 控制，带前缀代理仍需正确转发其原有回调路由。
- 公网使用 HTTPS；不要把生产 token 粘贴到第三方编辑器。

原生游戏界面可能缓存用户信息，应用后刷新游戏 / 重新进入房间查看，不承诺所有已打开视图实时推送更新。

## 数据与规则

账号数据库中新增一条记录：

```text
custom-badge/user/<userId>
```

包含 `schemaVersion`、`version`、`draft`、`published`、`blocked`、`updatedAt`、`lastSavedAt` 和最近一次 `moderation`。草稿是结构化几何数据；已发布图案是服务端编译后的原生 Badge。当前佩戴值仍存原字段 `user/<userId>` 的 `badge`，已有头像读取、SVG、地图和用户接口不换协议。

- 账号级：两个赛季共用；共用账号数据库的 shard 也共用。
- respawn、清场、赛季重开都不会删除头像或草稿。
- 原版编辑器改色 / 换 Badge，不会覆盖本 mod 的私人设计草稿；此时再打开 Studio 加载的仍是草稿。
- 玩家「恢复默认头像」撤销当前自定义授权并恢复原版默认图案，保留草稿。
- 管理员「重置」清除草稿、已发布授权，并恢复当前头像；不改变原有封禁状态。
- 「重置并禁用」执行同样清理并阻止该账号保存 / 发布自定义设计；原版和合法饰品 Badge 仍可使用。
- 「解除禁用」只解除限制，**不会复活之前的图案**。
- `enabled: false` 暂停自定义保存 / 授权并隐藏菜单，不删除已佩戴头像。仍可恢复默认、使用原版图案和执行管理操作。
- 卸载 mod 不会删除已佩戴的原生 Badge；私人草稿留在独立记录中。重新启用可读回。生产清理 / 回滚前应备份账号数据库。

mod 加载时注册 `User.remove` 清理 hook。直接运行不加载后端 mod 的运维脚本（包括当前 `manage` 命令）时，先显式导入 `xxscreeps/mods/custom-badge/model.js` 才会注册本 mod 的授权 / 删除 hook。不要直接写存储绕过接口进行玩家日常修改；运维直接写库也不受玩家接口权限约束。

## 接口

除配置读取外均需有效本服 `X-Token`。POST 为 `application/json`，最大 64 KiB（全局 body parser 仍使用服务器原有上限，本 mod 会另行拒绝超限请求）。生产反向代理也可给这组接口设置更小请求体限制。

| 方法 | 路径 | 请求 / 作用 |
| --- | --- | --- |
| GET | `/api/custom-badge/config` | 公开能力、限额、可用登录方式；不公开管理员列表 |
| GET | `/api/custom-badge/me` | 本人草稿、版本、当前 Badge、封禁状态 |
| POST | `/api/custom-badge/save` | `{ version, drawing, publish }`；`publish: false` 仅草稿 |
| POST | `/api/custom-badge/reset` | `{ version }`；恢复默认，保留草稿 |
| GET | `/api/custom-badge/admin/user?userId=…` | 管理员查询目标账号 / 当前版本 |
| POST | `/api/custom-badge/admin/moderate` | `{ userId, version, action: "reset" | "block" | "unblock" }` |

`version` 从 GET 响应取得。缺少身份 / 过期 token 为 401；未授权 / 禁用为 403；版本冲突为 409；冷却为 429 并返回 `Retry-After`；不合法绘图为 400。失败不会提升版本或部分保存。

```json
{
  "schemaVersion": 1,
  "colors": ["#15232e", "#55d6be", "#f5d58a"],
  "shapes": [{
    "id": "triangle-1", "kind": "triangle", "layer": 1,
    "x": 50, "y": 50, "width": 60, "height": 60,
    "rotation": 0, "mirrorX": false, "mirrorY": false
  }]
}
```

所有形状均以中心定位。中心坐标 0–100，宽高 0.5–200，旋转 -180–180 度。多边形额外携带 `points: [{x,y},…]`，局部坐标 -50–50，3–16 个顶点，拒绝自交和退化形状。同层路径保持一致绕向，镜像不会在重叠区域意外挖洞。颜色规范化为小写，数值规范化到小数点后三位。

## 安全与实现边界

1. 不接收任意 SVG / path；服务端独立校验并生成所有路径。前端预览不是安全边界。
2. 私人接口不接受目标用户 ID，始终使用当前登录身份；管理接口单独按配置白名单授权。
3. 草稿、授权、佩戴值用存储脚本原子更新；比较旧版本记录和旧佩戴值，冲突时整次拒绝。提供本地存储和 Redis Lua 实现。
4. mod 内拦截原有 `POST /api/user/badge`，继续调用原生 `Badge.validate`，再以同一原子提交规则保存。这样先校验、后遇到管理员撤权的旧请求不能把违规头像写回来；没有修改公共接口源文件。
5. 静态资源仅允许 `editor.js`、`drawing.js`；页面有 CSP、禁止被 iframe 嵌入、禁用 referrer，不包含第三方资源。DOM 文本用 `textContent`，SVG 用规范化数据设置属性。
6. 这是技术校验，不是自动内容审核。违规图案仍需管理员处理。

所有文件都在本 mod 目录内：`drawing.ts`（纯几何编译）、`model.ts`（存储 / 授权 / 并发）、`backend.ts`（接口 / 菜单 / 页面）、`editor.ts` / `page.ts`（编辑器）、`config.*`、`index.ts`、测试与本文档。

## 验收顺序

1. 隔离测试环境追加 mod，正常构建 / 重启后端；访问页面、原始 SVG 和菜单配置。
2. 两个不同玩家登录：A 的草稿不能被 B 读取；未登录不能保存；原版 / 饰品 Badge 可正常设置。
3. 绘制四类图形，拖动、缩放、旋转、镜像、改色、撤销 / 重做；草稿不应用，发布才更新账号。
4. 刷新 / 重启后读取相同草稿、头像和版本；两个窗口同时保存，后提交的旧版本得到 409。
5. 管理员禁用：当前头像恢复默认，旧图案不能通过旧保存接口穿透；解禁后需重新设计 / 发布。
6. 赛季 1 和赛季 2 正常落地、记分、respawn；头像独立保持。实际 Steam 客户端菜单点击、世界地图 / 房间 / 个人信息页显示由部署环境联合验收。

自动化测试通过 `xxscreeps test custom-badge` 运行。测试 HTTP 服务只监听 `127.0.0.1` 并使用隔离数据，不是完整游戏服务；正常加载 mod 不会启动它。

当前验证记录见 `VERIFICATION.md`。**未替你部署线上或修改生产配置。**
