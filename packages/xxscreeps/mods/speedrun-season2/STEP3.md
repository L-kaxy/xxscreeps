# 赛季 2 第 3 步 地图显式初始化验收

日期：2026-10-12。实现、自动测试及用户验收已通过；用户确认“通过，继续下一步”，授权开始第 4 步。

以下保留第 3 步交付时的功能边界和操作；当前进度以 [TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md) 为准。

**仅在完整存档的测试副本中初始化。线上可以正常部署本步代码，但暂不要执行初始化命令。** E3N3 落地限制、独立 Invader/claim/Ruin、比赛与清场尚未实现，不能把本步地图当成可上线赛季。

## 修改文件及原因

| 文件 | 原因 |
| --- | --- |
| [original-map.json](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/assets/original-map.json)、[资源说明](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/assets/README.md)、同目录许可文件 | 固定原版私服 81 房地形、335 个初始地图对象和来源，不依赖开发机路径；保留上游许可 |
| [original-map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/original-map.ts) | 平移房名、直接复制地形和坐标、生成不冲突的对象 ID，并生成新区块必要的 sector 引用 |
| [map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/map.ts) | 实现预览、停服初始化、备份日志及区块回滚；保护旧数据，拒绝覆盖已有目标 |
| [season2-map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/scripts/season2-map.ts)、[xxscreeps.js](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js) | 提供显式 CLI 命令；默认只预览，写入要求停服确认；入口只增加命令路由 |
| [map-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/map-test.ts)、[test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts) | 地图专项、实际 CLI 持久化测试、故障恢复和旧区块保护 |
| [index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts) 及步骤文档 | 说明显式命令不等于启动 provider；记录第 2 步确认、本步交付 |

**本步没有修改赛季 1 的运行代码，没有新增配置项或赛季 2 运行钩子。**

## 写入内容与保护

- 仅加入 `E1N1～E9N9` 的 81 房，`W7N3 → E3N3`，房内坐标不变。不调用地图生成器，不修出口，不校验连通性或落地空间。
- 写入两份新区块房间缓冲 `room0/E…`、`room1/E…`，然后按当前世界合并 `terrain`，将新区块加入开放房间集合 `rooms`。不修改旧房间缓冲，不重置 tick，不导入用户、代码或比赛数据。
- 新中央九房开放、不封墙，正常执行资源和 Source Keeper 处理。四条既有 highway 的地形、对象和开放状态保持原样；不新增边界房间或跨区拦截。
- 对象 ID 重新生成，并避开已有地图两份缓冲的 ID；中央 sector 的成员和边界引用使用新区块名称。旧 sector 引用保持原值。
- 原版数据库带有四个机器人 Spawn，不导入；原 Controller 的机器人所有权清空为无主 RCL 0。Source、Mineral、Keeper Lair 及初始中立 Extractor 的布局保留；矿量按引擎 int32 截去原浮点小数。
- 初始命令的 `rooms: 81`、`objects: 335` 是计划写入数量，不是运行后包含 NPC Creep 的实时对象数量。

### 默认预览与重复执行

```bash
xxscreeps season2-map --dry-run
xxscreeps season2-map --initialize --server-stopped
xxscreeps season2-map --restore --server-stopped
```

省略动作参数也只预览。`--shard name` 可指定已有配置中的目标 shard，默认使用第一个。

- 首次发现目标房间已有地形、开放记录或任一缓冲：预览列出 `conflicts`，非零退出；初始化拒绝写入，没有 `--force`。
- 初始化成功：`state: complete, written: true`。
- 再次显式初始化：`state: complete, written: false`，不重新拍图，不抹掉新地图后来产生的对象。
- 只启动或重启服务：不会初始化地图。
- 检测到服务主锁，或本地模式仍有另一个存储宿主：拒绝写入。`--server-stopped` 只是确认参数，不会帮你停服；必须停止全部服务，不能仅 pause 或从运行容器 `docker exec` 写图。

### 备份与失败恢复

初始化在首次地图写入前持久化：

```text
speedrun-season2/mapBackup/terrain
speedrun-season2/mapBackup/openRooms
speedrun-season2/mapState
```

前两个是本次操作前的整个世界地形和开放房间集合；日志记录 tick、来源及新对象 ID。**这不是包含旧玩家建筑、账号和成绩的完整存档备份**，仍需保留第 0 步约定的停服快照。

日志处于 `prepared` 时表示操作未完成，禁止盲目重跑初始化或直接启服。保持停服，先执行 `--restore --server-stopped`，确认 `restored`，再预览和重新初始化；不要手工删除日志键来绕过保护。

回滚只移除本命令新增的 81 房及缓冲，并合并当前世界。不会直接把整份旧 terrain 备份写回，也不会覆盖旧区块后来发生的修改。自然生成的 Source Keeper NPC 可以随新区块移除；发现玩家控制器、玩家 Creep、新建筑或施工点等活动则拒绝回滚，改用完整测试副本快照恢复。

## 自动测试实际结果

| 检查 | 实际结果 |
| --- | --- |
| TypeScript `tsc -b`；本步 mod、脚本及命令入口严格 ESLint | 通过 |
| 地图专项 | 26/26 |
| 配置骨架专项 | 20/20 |
| 旧赛季八组专项，仅旧 mod / 双 mod | 各 80/80 |
| 公共比赛专项，仅旧 mod / 双 mod | 各 15/15 |
| 默认完整测试，不启用赛季 mod | 667/667 |
| 原始私服数据库与固定资源对照 | 81 房、202500 格及 335 个对象一致 |
| 初始化、只读现场检查及回滚命令，本地临时存档等价执行 | 通过 |

另外执行了整包混跑：仅旧 mod 为 **739/761**，双 mod 为 **785/807**，均有 **22 项既有失败**。失败名称及顺序与第 2 步基线一致，没有新增失败；不将这两次整包记录为全通过。

专项覆盖：旧地形和两个旧房间缓冲不变、旧开放状态及比赛数据保留、ID 冲突、中央九房正常处理、四条 highway 保持、奇数 tick 的双缓冲、重复与并发初始化、半途失败恢复、回滚不伤旧区块、玩家对象保护和真实 CLI 跨进程持久化。

复测中修正了本步代码的 blob 删除方式，避免 local provider 的 `mDel` 漏删房间缓冲；测试道路创建补齐 Game 上下文，terrain 比较避开序列化填充字节，CLI 临时目录缩短以适配 macOS Unix socket 长度。未改旧赛季代码或私服地形。

测试日志：`/private/tmp/xxscreeps-season2-step3.xR7yW1`。只读现场检查结果另在 `/private/tmp/xs2check.HGu0x2/inspection.json`。全部为临时测试存档，没有操作线上数据。

## 本地复测

```bash
cd /Users/jason/workspace/nodejs/xxscreeps
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint --max-warnings 0 \
  packages/xxscreeps/mods/speedrun-season2 \
  packages/xxscreeps/scripts/season2-map.ts packages/xxscreeps/xxscreeps.js
```

在启用双 mod 的**独立测试目录**逐条执行：

```bash
bin=/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js
node --experimental-vm-modules "$bin" test "season-2 map"
node --experimental-vm-modules "$bin" test "mods/speedrun-season2"
node --experimental-vm-modules "$bin" test "race core"
```

分别应为 26/26、20/20、15/15，不能是 `0 tests`。测试使用独立测试存档；实际 CLI 集成测试会在临时目录建立本地 IPC socket，需要环境允许。不要在同一配置目录并发测试进程。

## 测试副本部署和验收

### 1 更新代码，保留完整备份

正常构建并部署到测试环境，保留旧配置、存档和两个 mod。没有新增配置；旧 `speedrun` 根节点不要修改。部署代码及正常重启本身不会拍图。

记录旧地图及 `/speedrun` 成绩，并保留完整停服存档快照。新区块尚未实现落地限制，**本步不让玩家在新区块落地**。

### 2 停服，预览，再显式初始化

停止全部测试服务。在同一配置、数据卷和网络环境下运行命令，不能使用另一个空数据目录。

以下 Docker 示例仅适用于本项目默认 ENTRYPOINT、本地存储和配置均放在共享 `/data` 的单容器测试部署。容器名按实际替换；Redis、分服务或环境变量部署需同时停止所有服务，并复用原网络和配置。

```bash
image=$(docker inspect -f '{{.Image}}' xxscreeps-test)
docker stop xxscreeps-test

docker run --rm --volumes-from xxscreeps-test -w /data "$image" \
  season2-map --dry-run

docker run --rm --volumes-from xxscreeps-test -w /data "$image" \
  season2-map --initialize --server-stopped
```

先确认预览为 `ready`、`written: false`、81 房、335 个初始对象、`conflicts: []`，映射包含 `W7N3 → E3N3`。出现冲突先停下，不强行覆盖或删除数据。

初始化应为 `complete`、`written: true`。主锁尚未释放时等待停服完成或锁自然过期，不手工删除锁。若报 `prepared`，按上方失败恢复执行，不立即启服。

可在停服状态再执行一次初始化，确认 `complete`、`written: false`，随后：

```bash
docker start xxscreeps-test
```

### 3 检查新区块现场

下面是只读存档检查，不初始化、清理或重置比赛：

```bash
docker exec -w /data xxscreeps-test \
  /xxscreeps/node_modules/.bin/xxscreeps eval -e \
  '(async () => {
    const { Database, Shard } = await import("xxscreeps/engine/db/index.js");
    const { config } = await import("xxscreeps/config/index.js");
    const { isSeason2Room } = await import("xxscreeps/mods/speedrun-season2/rooms.js");
    await using db = await Database.connect();
    await using shard = await Shard.connect(db, config.shards[0].name);
    const world = await shard.loadWorld();
    const room = await shard.loadRoom("E3N3");
    const center = [];
    for (let x = 4; x <= 6; x++) for (let y = 4; y <= 6; y++) {
      const name = `E${x}N${y}`;
      center.push({ name, status: world.map.getRoomStatus(name).status });
    }
    return JSON.stringify({
      tick: shard.time,
      rooms: [...world.terrain.keys()].filter(isSeason2Room).length,
      center,
      E3N3: {
        level: room["#level"],
        objects: room["#objects"].map(o => ({ type: o.constructor.name, x: o.pos.x, y: o.pos.y }))
      }
    }, null, 2);
  })()'
```

预期：

- 新区块 81 房，中央九房状态全部 `normal`；不被旧钩子封墙。
- `E3N3` 无主 RCL 0，初始对象为 Source `(41,3)`、Source `(38,6)`、Controller `(36,18)`、Mineral `(24,29)`。
- 客户端可看到新房间地形，旧区块地形和建筑保持原样，旧 `/speedrun` 正常、既有成绩保留，tick 继续推进。
- 既有四条 highway 状态不因初始化改变。源库地形没有出口修复、随机改造或房内镜像。
- 再完整重启，地图仍存在，没有重新生成日志或初始化写入；**不测试 E3N3 落地限制或赛季 2 成绩**，它们尚未接入。

### 4 可选回滚测试

再次停止全部测试服务，用本步镜像执行：

```bash
docker stop xxscreeps-test
docker run --rm --volumes-from xxscreeps-test -w /data "$image" \
  season2-map --restore --server-stopped
docker start xxscreeps-test
```

预期 `restored`、`written: true`，新区块地形和缓冲移除，旧地图、建筑和成绩不变；重复回滚为 `written: false`。已发生玩家活动则保护性拒绝，使用完整停服测试快照，不绕过保护。

移除新 mod 或回滚代码**不会自行移除新区块**。需要移除地图时，先用本步版本执行受保护回滚，或恢复完整停服快照，再回滚版本。只部署代码、未初始化时则正常回滚版本即可。

## 用户确认

- [ ] 测试副本预览、初始化及重复执行符合预期。
- [ ] 新区块地形与 E3N3 初始对象正确，中央九房开放。
- [ ] 旧赛季地图、建筑、成绩正常；重启不重拍新区块。
- [x] 用户确认第 3 步通过，授权开始第 4 步落地限制。
