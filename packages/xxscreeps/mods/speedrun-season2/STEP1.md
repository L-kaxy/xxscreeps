# 赛季 2 第 1 步 骨架与配置验收

> 此文记录第 1 步当时的配置和测试结果。2026-10-13 第 6、7 步已移除 `speedrunSeason2.claimController`、`speedrunSeason2.ruins`；不要再复制下方历史示例中的这两个键，现行配置和升级操作见 [STEP6-7.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP6-7.md)。

本步仅建立可加载的 mod、独立配置和房间范围函数。**尚未实现地图初始化、E3N3 落地限制、Invader、claim、Ruin、比赛、清场或排行榜。** 配置可以读取和校验，但不会执行赛季 2 玩法。

当前验收状态：第 1 步实现、专项自动测试和用户验收已通过；用户已授权开始第 2 步。

## 修改文件及原因

所有新增代码均位于 `/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2`，不修改旧赛季运行代码。

| 文件 | 原因 |
| --- | --- |
| `index.ts` | 声明依赖旧赛季，确保旧基础先加载；本步只提供 `config` 和 `test`，不注册运行钩子 |
| `config.ts` | 定义独立 `speedrunSeason2` 类型与默认值，不从旧配置回退读取 |
| `config.schema.json` | 校验六个支持的配置项；拒绝错误类型、未知字段及不属于赛季 2 的资源和封墙开关 |
| `rooms.ts` | 精确判断新区块 81 房；提供 E3N3 候选判断，暂不接入落地执行 |
| `test.ts` | 检查实际 mod 加载、默认值、schema、范围边界及新旧配置隔离 |
| `README.md`、`TODO.md`、`STEP1.md` | 同步已实现范围、自动测试结果和用户验收步骤 |

## 自动测试实际结果

测试日期：2026-10-12。没有部署线上服务或操作真实存档。

| 检查 | 实际结果 |
| --- | --- |
| TypeScript `tsc -b` | 通过 |
| 新增代码 ESLint `--max-warnings 0` | 通过 |
| 赛季 2 骨架专项 | 20/20 |
| 仅旧 mod 下的旧赛季八组专项，逐组独立进程执行 | 80/80 |
| 双 mod 下的相同旧赛季八组专项，逐组独立进程执行 | 80/80 |
| 不启用赛季 mod 的默认完整测试 | 667/667 |
| 文档中的只读配置检查命令，本地等价执行 | 正确输出两个配置根节点 |

旧赛季专项为 `season-1 scope`、`mods/speedrun`、`ruin suppression`、`respawn cleanup`、`race results`、`race pages`、`race restarts` 和 `uniform rooms`。

另外实际执行过启用赛季 mod 后的整包混跑，结果为：

- 仅旧 mod：746 项，724 通过，22 失败。
- 双 mod：766 项，744 通过，22 失败。
- 对比两份日志，失败测试名称和顺序完全一致，新骨架没有增加失败。多数失败是原版测试期望产生 Ruin、Invader 或资源，而旧赛季规则禁止这些行为；`uniform rooms` 的一项在整包混跑时也存在相同失败，单独运行该组通过。
- 不把这两次整包混跑标记为全通过。本步使用默认原版完整测试、旧赛季独立专项和新骨架专项分别验收，保留上述对照结果。

实际日志目录：`/private/tmp/xxscreeps-season2-step1.U0H0vy`。

### 本地复测

先在仓库构建：

```bash
cd /Users/jason/workspace/nodejs/xxscreeps
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint --max-warnings 0 packages/xxscreeps/mods/speedrun-season2
node --experimental-vm-modules packages/xxscreeps/xxscreeps.js test --sandbox unsafe
```

默认完整测试这一行以仓库没有启用赛季 mod 的 `.screepsrc.yaml` 为前提；存在本地自定义配置时，改在只配置默认 mod 的独立测试目录执行。

再创建独立配置目录，启用两个 mod；不复制真实存档：

```bash
test_dir=$(mktemp -d /tmp/xxscreeps-season2-step1.XXXXXX)
cat > "$test_dir/.screepsrc.yaml" <<'YAML'
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/speedrun
  - xxscreeps/mods/speedrun-season2
runner:
  sandbox: unsafe
YAML

cd "$test_dir"
bin=/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js
node --experimental-vm-modules "$bin" test "mods/speedrun-season2"

for suite in "season-1 scope" "mods/speedrun" "ruin suppression" \
  "respawn cleanup" "race results" "race pages" "race restarts" "uniform rooms"; do
  node --experimental-vm-modules "$bin" test "$suite" || break
done
```

预期新骨架 20/20，旧赛季八组分别为 20、23、3、6、7、8、6、7 项，全部通过。将测试配置中的新 mod 删除后重跑八组，即为仅旧 mod 的对照回归。

## 测试环境部署

按正常方式构建、更新测试环境镜像，保留现有存档和配置。**不要执行 import、uniform-terrain 或地图初始化。**

在测试环境的 `.screepsrc.yaml` 保留原有 `mods` 项，追加：

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/speedrun
  - xxscreeps/mods/speedrun-season2

speedrunSeason2:
  invaders: false
  ruins: false
  respawnCleanup: true
  raceBrackets: [20000, 40000]
  respawnAfter: 40000
  claimController: false
```

已有其他 mod 时不要用示例覆盖整个列表；旧 `speedrun` 配置保持原样。省略 `speedrunSeason2` 根节点也会加载上述独立默认值。

不要在新根节点加入 `deposits`、`powerBanks`、`closeCenterNine` 或 `wallSectorCores`。前两个仍在旧 `speedrun` 下全图控制，后两个不属于新赛季玩法。

完整重启测试服务。本步不会创建新区块或新的比赛数据，不需要存档迁移。

## 用户验收操作

以下命令假设测试容器名为 `xxscreeps-test`、工作目录为 `/data`，按实际部署替换容器名。

### 1 检查独立配置

```bash
docker exec -w /data xxscreeps-test \
  /xxscreeps/node_modules/.bin/xxscreeps eval -e \
  'import("xxscreeps/config/index.js").then(({ config }) => JSON.stringify({ speedrun: config.speedrun, speedrunSeason2: config.speedrunSeason2 }, null, 2))'
```

预期：输出两个独立根节点；旧配置保持原值，新配置包含六个默认项。本命令只读取配置，不连接游戏存档。

### 2 检查 mod 和范围测试

```bash
docker exec -w /data xxscreeps-test \
  /xxscreeps/node_modules/.bin/xxscreeps test "mods/speedrun-season2"
```

预期：20 个测试全部通过，不是 `0 tests`。覆盖实际加载顺序、重复依赖去重、独立配置、错误类型拒绝、81 房边界和 E3N3 候选判断。

这些测试使用临时配置及独立进程，不初始化线上地图；本步配置测试不连接真实数据库。

### 3 验证配置不会串用

仅在测试配置中将 `speedrunSeason2.invaders` 改为 `true`，其他项和旧配置不变，重启后再次执行配置读取命令。

预期：新根节点显示 `true`，旧 `speedrun.invaders` 保持原值。恢复测试前的配置并重启。

此时只验证配置隔离，**不验证实际入侵开关效果**，那是第 5 步。

### 4 检查旧赛季

- 旧 `/speedrun` 页面正常打开，已有成绩没有被重置。
- 旧赛季玩家仍正常运行，原有地图没有因新骨架而变化。
- 没有赛季 2 自动拍图、封墙、关闭中央九房、清场或榜单入口。
- 本步不尝试在新区块落地；E3N3 的实际限制还没有接入。

### 5 可选验证配置校验

在测试配置中暂时使用 `invaders: "false"`，执行配置读取命令。

预期：进程非零退出，提示 `speedrunSeason2/invaders must be boolean`。修改为布尔值 `false` 后恢复正常。

这项只在测试配置执行，不故意破坏正在运行的线上配置。

## 回滚

从测试 `mods` 列表移除 `xxscreeps/mods/speedrun-season2`，同时移除 `speedrunSeason2` 根节点，完整重启。

本步没有新增存档写入或格式变化，不需要删除数据、恢复地形或清理新赛季存储键。旧赛季仍按原配置运行。

## 用户确认清单

- [ ] 测试服务正常启动。
- [ ] 两个配置根节点正确且互不影响。
- [ ] 赛季 2 的 20 个测试全部通过。
- [ ] 旧赛季页面、玩家和数据正常。
- [x] 用户已确认第 1 步通过，允许继续第 2 步。

上方分项手动操作由用户整步确认验收；本对话未另行记录每项操作的执行日志。
