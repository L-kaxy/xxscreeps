# Speedrun 服：部署 / 运维 quickstart

这份文档是 **`speedrun` 分支**（本仓库，基于上游 [xxscreeps](https://github.com/laverdet/xxscreeps)）的部署与运维说明：一套「速通玩法」规则集 + 一张统一地形的世界 + 一个成绩榜页面。

适用对象：想自己开一套**速通规则**私服的人（Docker 一条龙）；也可以用来把本分支合并回自己的 fork。

- 分支：`speedrun`（克隆/切换见 §3.1）
- 与上游的差异清单：§2
- 新增/改动指令：§5
- 地图（统一地形）更新：§6
- 装完怎么验收：§8

**TL;DR（五条命令）**

```bash
git clone -b speedrun https://github.com/L-kaxy/xxscreeps.git && cd xxscreeps
docker build . -t xxscreeps
mkdir -p ~/xxscreeps-data && docker run -it --rm -v ~/xxscreeps-data:/data xxscreeps import
# ← 编辑 ~/xxscreeps-data/.screepsrc.yaml：在 mods: 里加一行  - xxscreeps/mods/speedrun
docker run -d --name xxscreeps --restart unless-stopped -p 21025:21025 -v ~/xxscreeps-data:/data xxscreeps start
docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps uniform-terrain --terrain-type 1 --swamp-type 0 --sources 2
```

---

## 1. 这套规则集做了什么

| 干什么 | 效果 |
|---|---|
| **统一地形** | 把所有非核心房间刷成**同一套地形**（同一套源/矿物/控制器落位），每间房开局条件相同；相邻房间的出口逐格对齐，上下左右都走得通 |
| **封核心** | 每扇区中心 3×3（核心 9 房）封死：房间关闭 + 地形全墙，且与核心共边的 12 间房朝核心那条边整条封死 ⇒ 人只能在自己的 9×9 内部玩 |
| **去掉随机事件** | 定期入侵、deposit、power bank 生成关闭；结构被摧毁不留废墟 |
| **禁占房** | `claimController` 禁用 ⇒ 只能在自己落地那间房发展（房间归属靠落地，不靠占控制器） |
| **竞速成绩** | 每次落地开始一局；开局后 **20000 / 40000 tick** 各记一次成绩（RCL + 控制点）；满 **40000 tick 自动交还**（和点客户端 respawn 按钮同一个实现）：房间、物件、控制器全部交回世界，玩家自己再找地方落地 |
| **成绩榜页面** | `/speedrun`：上方「Racing now」实时榜（直接读房间），下方左右两块 **20k / 40k** 累计榜；点玩家看该玩家全部记录；客户端侧边栏有入口（新标签打开） |

入榜规则：**丢房不入榜**（房间被抢/自己丢了就不记）、**RCL < 2 不入榜**、每条成绩带**入榜时间戳**；一局结束后该玩家不再更新该局数据。

---

## 2. 与上游的差异（改动清单）

规则集本体全部在 `packages/xxscreeps/mods/speedrun/`（**17 个文件，全部新增**）。另有 **16 个文件**必须动到核心，因为服务消息、进程内缓存、CLI 命令入口是 mod 够不着的地方：

| 位置 | 文件 | 为什么必须在 mod 外面 |
|---|---|---|
| `mods/classic/spawn/` | `model.ts`（新）、`backend.ts`（改） | 抽出的公共 `respawnPlayer`：自动交还、`manage user respawn`、游戏内 respawn 按钮**共用同一份实现** |
| `engine/` | `service/{index,main,processor,runner}.ts`、`processor/model.ts`、`runner/{model,instance}.ts`（7） | `reloadTerrain` 服务消息：main 转发 → processor/runner 下一 tick 重读地形并重灌寻路器、玩家沙箱重建 |
| `backend/` | `context.ts`、`server.ts`、`endpoints/game/terrain.ts`、`endpoints/assets/terrain.ts`（4） | backend 的 `world` 可重载；两处地形缓存改按 `World`/`GameMap` 键控（上游按房间名缓存、进程余生不失效） |
| `scripts/` | `uniform-terrain.ts`（新）、`manage.ts`（改） | CLI 命令在 `scripts/` 里，mod 不提供命令 |
| `xxscreeps.js` | 1 行 | 命令表注册 `uniform-terrain` |

自查：本分支的基准是上游 `main` 的 `4795a332`。

```bash
git diff --name-status 4795a332..speedrun     # 33 个文件（17 个在 mods/speedrun/，16 个在外面）
grep -rn '// Fork' packages/xxscreeps         # fork 改动都带这个标记（16 处），合上游时按它对齐
```

⚠️ 外面这 16 个文件**不含任何玩法规则**，只是管道。`.screepsrc.yaml` 的 `mods:` 里去掉 `xxscreeps/mods/speedrun`，玩法和页面就回到原版；管道是惰性的（没人发那条消息就什么都不会发生）。

---

## 3. Docker 部署

### 3.1 拿代码

```bash
git clone -b speedrun https://github.com/L-kaxy/xxscreeps.git
cd xxscreeps
# 或者克隆过这个 fork：
#   git fetch --depth=1 origin speedrun && git switch -C speedrun FETCH_HEAD
```

### 3.2 构建镜像

```bash
docker build . -t xxscreeps
```

构建里会跑 `pnpm run build`（`tsc -b`）**和 `npx xxscreeps test`**，两者都过才会出镜像。第一次 build 要装依赖，几分钟起（看机器和网络）。

### 3.3 播种世界（首次一次）

```bash
mkdir -p ~/xxscreeps-data
docker run -it --rm -v ~/xxscreeps-data:/data xxscreeps import
```

会写 `~/xxscreeps-data/.screepsrc.yaml` 并播种默认世界（121 房 = 11×11）。

### 3.4 改配置（关键一步）

编辑 `~/xxscreeps-data/.screepsrc.yaml`，**在 `mods:` 里加一行**，否则规则集**静默不生效、零报错**：

```yaml
# 以 import 生成的那份为准，只加最后一行的 speedrun
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/backend/cookie
  - xxscreeps/mods/backend/email
  - xxscreeps/mods/backend/password
  - xxscreeps/mods/backend/steam
  - xxscreeps/mods/speedrun        # ← 规则集本体
```

可选开关（默认值已经就是「速通」形态，不改也行）：

```yaml
speedrun:
  invaders: false          # 定期入侵：关（房间的 harvest 预算每 tick 清零）
  deposits: false          # deposit 生成：关
  powerBanks: false        # power bank 生成：关
  ruins: false             # 结构被摧毁留废墟：关
  claimController: false   # 允许占中立控制器：关（禁占房）
  closeCenterNine: true    # 核心 3×3 房间关闭：开
  wallSectorCores: true    # 核心 3×3 地形全墙：开
  respawnCleanup: true     # 交还时清掉中立路/容器/墙：开
  raceBrackets: [20000, 40000]   # 记成绩的 tick 档位
  respawnAfter: 40000            # 一局多长（tick），到点自动交还
```

让朋友能自己注册（否则只能你用 `manage user create` 建号）：

```yaml
backend:
  allowEmailRegistration: true
  secret: '自己编一个随机串'
```

想用浏览器直接看世界（客户端）：装 `@xxscreeps/client` 这个 peer 包并把它加进 `mods:`。
⚠️ 它直接分发 Steam 客户端的文件，**只在自己机器/内网用，别装在公网服务器**。

### 3.5 起服

```bash
docker run -d --name xxscreeps --restart unless-stopped \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 21025:21025 -v ~/xxscreeps-data:/data xxscreeps start
```

数据（存档 + 配置）全在宿主 `~/xxscreeps-data` 里，容器可随时删了重建。日志里出现 `🌎 Listening` 就是起来了；浏览器开 `http://<host>:21025/`。

### 3.6 覆盖地图（第一次一定要做）

`import` 出来的是**原版地形**（每间房不一样），速通服需要统一地形：

```bash
docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps \
  uniform-terrain --terrain-type 1 --swamp-type 0 --sources 2
```

跑完按提示重启服务或发一次地形重载（§6.3）。这样**全部房间条件一致**、相邻房间出口对齐。

### 3.7 升级 / 回滚

```bash
cd xxscreeps
git fetch --depth=1 origin speedrun && git switch -C speedrun FETCH_HEAD
docker build . -t xxscreeps
docker rm -f xxscreeps          # 数据在挂载目录里，不受影响
docker run -d ...（和 3.5 完全一样的参数）
```

回滚：切回旧提交重新 build，或者把数据目录换成备份。**动存档前先整目录备份**：

```bash
docker stop xxscreeps
tar czf ~/xxscreeps-data-$(date +%F).tar.gz -C ~ xxscreeps-data
docker start xxscreeps
```

---

## 4. 规则一览（玩之前知道这些就够）

- **开局**：落地（放 spawn）在任意非核心房间 = 开始一局；同一房间可以被不同玩家先后用。
- **成绩**：开局后第 20000 / 40000 tick 快照一次你房间的控制器等级 + 进度（控制点 = 已满级数 + 当前级进度）。丢房或 RCL < 2 则那一档不记。
- **自动交还**：满 `respawnAfter`（40000）tick，服务端把你所有房间交回世界（等于点了 respawn 按钮），**不会**帮你放新 spawn；下一局从你下次落地开始。交还前你随时可以在别处落地开新的一局（旧的按「被顶替」处理）。
- **看榜**：客户端侧边栏 → Speedrun（新标签），或直接 `<host>:21025/speedrun`。
- 卡住了、想让某个号立刻重来：`manage user respawn <名字或 id>`（§5）。

---

## 5. 新增 / 改动的指令

所有命令都在**容器里**跑。⚠️ `manage` / `uniform-terrain` 不是可执行文件，必须写全路径：

```bash
docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps <command> [args]
```

（直接 `docker exec xxscreeps manage …` 会报 `exec: "manage": executable file not found in $PATH`。）

服务**没在跑**时用一次性容器，参数一样：

```bash
docker run --rm -it -v ~/xxscreeps-data:/data xxscreeps <command> [args]
```

| 指令 | 干什么 | 例子 |
|---|---|---|
| `uniform-terrain` | **一次性**把全世界的内部房间刷成同一套地形 + 一套物件落位（详见 §6） | `… uniform-terrain --terrain-type 1 --swamp-type 0 --sources 2` |
| `manage game reload-terrain` | 让运行中的服务**重读地形**（backend 立刻生效、引擎下一 tick 生效），不用重启、不踢人；玩家沙箱会用新地形重建（Memory / CPU 不清） | `… manage game reload-terrain` |
| `manage user respawn <名字\|id>` | 立刻把某个玩家按「丢房」处理（排交还意图，下一 tick 生效）；成绩不再更新 | `… manage user respawn E9C50` |
| `manage user list` | 列出所有账号（id ↔ 用户名），拿 id 用 | `… manage user list` |
| 上游原有 | `manage user create/show/remove/password/branch`、`manage decoration …`、`manage bot add/update/remove`、`manage game pause/unpause/pause-tick` | 见仓库 README 的 Operator CLI |

成绩相关的 key（排查用，只读）：`speedrun/racing`（在跑的局）、`speedrun/due`（还没到点的档位）、`speedrun/run/<userId>`（某玩家当前局）、`speedrun/score/<档位>/<runId>`、`speedrun/best/<档位>`。

---

## 6. 地图更新：`uniform-terrain`

### 6.1 它做什么

把每扇区 9×9 内部（81 − 核心 9 = **72 间房**）刷成同一张模板：地形用上游 `generate-room` 的生成器（同一套 `--terrain-type` / `--swamp-type` 取值），但四边都用**居中开口**，所以相邻两房逐格对齐；源 / 矿物 / 控制器按 `room-gen` 的规则落位（**放在墙格里 + 四周有可走地面**），参数一样、不需要指定房间号。

是一次性命令（跟 `generate-room` 一样用指令触发），**不会**随服务启动自动跑。

### 6.2 参数

```
xxscreeps uniform-terrain [--shard shard] [--terrain-type 1-28] [--swamp-type 0-14]
         [--exits 8] [--sources 1-4] [--mineral H|O|Z|K|U|L|X] [--no-objects]
         [--template file.json] [--save file.json] [--dry-run] [--restore] [--no-reload]
```

| 参数 | 作用 |
|---|---|
| `--terrain-type 1-28` | **墙型**：0.2–0.5 随机成墙 → 元胞自动机平滑 → 出口 8 格强制打通 → 分裂的地形修到连通。决定可走面积（实测 10%–87%）与建筑空间 |
| `--swamp-type 0-14` | **沼泽型**：同样随机 + 平滑，只动沼泽不动墙。`0` = 无沼泽（最干净最好走） |
| `--exits 8` | 每边居中开口的格数（必须偶数才会左右/上下对称）；相邻房间靠它对齐 |
| `--sources 1-4` | 每间房的源数量（默认 2） |
| `--mineral X` | 指定矿物种类，不写则随机一种 |
| `--no-objects` | 只换地形、不动源/矿物/控制器 |
| `--template f.json` | 用 `--save` 存下来的模板（同一张地图重刷，含物件计划） |
| `--save f.json` | 把这次的地形 + 平面图 + 物件计划存成文件 |
| `--dry-run` | 只预测、不写 |
| `--restore` | **回滚**：把地形和改过的房间还原成第一次刷之前的样子 |
| `--no-reload` | 跑完不给运行中的服务发重载消息（默认在「兄弟进程」模式下会自动发） |

常用组合（作者实测过）：`--terrain-type 1 --swamp-type 0 --sources 2`（地形最规整、无沼泽，可走面积 87%）；想要窄一点、需要规划建筑的图，用 `--terrain-type 13`（可走 ≈75%）或 `--terrain-type 20`（≈80%）；想要一点沼泽用 `--swamp-type 1`（≈2% 格）或 `--swamp-type 2`（≈6%）。
⚠️ `--terrain-type 4 / 11 / 12`（≈36% 可走）和 `8`（≈10%）在实测里是**极度逼仄/几乎无法开局**的图，别拿来做主图；`--swamp-type 3` 已经是 ≈25% 沼泽、`6` ≈46%。

### 6.3 生效时机（关键）

地形是**启动期读一次**的输入：backend 拿它给客户端画地图，processor / runner 拿它灌寻路器。所以改完地形，要么重启，要么发一次重载：

```
方案 A（改完就重启一次）：
  docker stop xxscreeps
  docker run --rm -it -v ~/xxscreeps-data:/data xxscreeps uniform-terrain --terrain-type 1 --swamp-type 0
  docker start xxscreeps          # 客户端强刷一次（Ctrl+Shift+R）

方案 B（服务跑着，热载）：
  docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps uniform-terrain --terrain-type 1 --swamp-type 0
  # 上面这条在容器里跑 = 跟引擎共用存储，跑完会自动发 reloadTerrain
  # 也可以手动补一条：manage game reload-terrain
```

⚠️ **只有地形能热载**。命令还会搬动/新建**房间里的物件**（源、矿物、控制器），而运行中的 tick 会把内存里的房间写回存储 ⇒ 物件那半会被回盖。所以：

- 只要地形：方案 B 可以（命令最后会提示 `storage: sibling`）。
- 地形 + 物件一起改：**停服**跑（方案 A），跑完再起。
- 命令会打印 `storage: sibling`（连的是运行中引擎的存储）或 `storage: files`（自己的一份磁盘副本）；`files` 而服务又在跑，等于白改物件。

### 6.4 输出怎么读

```
template: terrain-type 1, swamp-type 0, 8 tile exits
covered 72 rooms, opened 36 highway ring faces, terrain written
objects: 2 source(s) per room, one mineral and one controller; 72 room(s) rewritten, 259 object(s) moved, 30 added
ground beside the objects, before: 2 source(s), 1 mineral(s), 1 controller(s); after: none
every source, mineral and controller has ground to work from
storage: sibling
```

- `covered 72 rooms` = 覆盖到的房间数（每扇区 72；多扇区会累加）。
- `terrain already uniform` + `nothing written` = 幂等，已经刷过了（或用了 `--dry-run`）。
- `ground beside the objects, before/after` = 物件四周有没有可走地面；after 是 `none` 才算成功。
- `storage: …` = 见 §6.3；`files` 而服务在跑就先停服。

回滚：`… uniform-terrain --restore`（会把地形和改过的房间一起还原）。它依赖第一次刷之前留下的备份，只留一份、不会被覆盖。

---

## 7. 成绩与页面

- 页面：`http://<host>:21025/speedrun`（客户端侧边栏也有入口，新标签打开）。
- 三个接口：`/api/speedrun/leaderboard?bracket=20000&offset=0&limit=25`、`/api/speedrun/records/<userId>`、`/api/speedrun/racing`。
- 上方「Racing now」直接读房间（不是读历史成绩），所以进行中的局是实时的；列表里 `elapsed` 是墙钟时间（按 `game.tickSpeed` 换算），倒计时仍是 tick。
- 「满 40000 tick 自动交还」和客户端 respawn 按钮**同一个实现**：房间、物件、控制器交回世界，同时清掉中立路/容器/墙（`respawnCleanup`）。
- 排查：日志里 grep `speedrun:`。`… still holds W3N3 N tick(s) after the restart window` 表示交还没落地（玩家还在玩）；这种号会一直留在 `speedrun/racing` 里等交还，不会掉出计划。
- 想手动介入：`manage user respawn <id>`。

---

## 8. 装完怎么验收

1. 日志有 `🌎 Listening`；`curl -s http://127.0.0.1:21025/api/version` 有 JSON，且里面有 `speedrun` 这条 feature。
2. `docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps manage user list` 能列出账号（说明新命令在，镜像不是旧的）。
3. 客户端打开 `http://<host>:21025/speedrun`：能看到「Racing now」+ 左右两块榜（20k / 40k）。
4. 地图：随便进两间非核心房，地形、源、矿物、控制器位置**完全一样**（统一地形的签名）。地图贴图要客户端强刷一次（`Ctrl+Shift+R`）。
5. `uniform-terrain --dry-run` 再跑一次：应显示已统一（幂等）。

---

## 9. 已知边界

- **`.screepsrc.yaml` 的 `mods:` 是整体替换语义**：漏一个就是那块功能没了，而且**不报错**。改完要**重启服务**才生效。
- **地形只在启动（或 `reload-terrain`）时读**；只改磁盘上的 blob 不会热更新。
- **房间物件**（源/矿物/控制器）的改动要停服做（见 §6.3）。
- 服务默认 **HTTP**：放到公网请自己加反代 + HTTPS，并注意别装 `@xxscreeps/client`（会分发 Steam 客户端文件）。
- `import` 会**重建世界**（地形 + 房间名单），别在已有存档上随手跑；要重置世界时先备份 `~/xxscreeps-data`。
- 本仓库是 fork：`git merge upstream/main` 时看 `// Fork` 标记的 16 处改动（§2）。
