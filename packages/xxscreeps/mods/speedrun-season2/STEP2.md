# 赛季 2 第 2 步 比赛公共逻辑验收

日期：2026-10-12。实现和自动测试已完成，**等待用户验收；第 3 步尚未开始。**

本步只提取公共比赛逻辑并接回旧赛季。赛季 2 仍是配置骨架，没有比赛实例、落地钩子、计分或到期任务；不初始化地图，不清场，不新增排行榜页面。

## 修改文件及原因

| 文件 | 修改原因 |
| --- | --- |
| [race-core.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race-core.ts) | 提取比赛工厂 `createRace`，显式传入配置读取函数、房间谓词及存储命名空间；计分、计时、榜单、历史和到期逻辑不读取全局赛季配置，不自行注册钩子 |
| [race.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race.ts) | 保留旧模块入口及全部公开函数、类型、八类存储键，固定传入 `speedrun`、旧区块判断及 `config.speedrun`；旧调用方不需要修改 |
| [race-core-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race-core-test.ts) | 新增 15 项回归，覆盖旧键、旧存档继续计分、独立实例、范围过滤、榜单、历史、配置实时读取和到期任务隔离 |
| [test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/test.ts) | 接入公共比赛专项；修正两项旧地形测试的随机假设：修复测试固定样本，变化检测真正翻转 tile，实际地图生成代码未改 |
| [README.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/README.md)、[TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md)、[STEP1.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP1.md)、本文 | 记录第 1 步用户确认、本步范围、实际结果及部署验收方法 |

### 兼容性边界

- 六类账号级表仍为 `speedrun/run`、`score`、`rank`、`best`、`runs`、`brackets`；两个 shard 队列仍为 `speedrun/due`、`speedrun/racing`。
- 用户局数、runId、队列成员、成绩字段、档位、排序和分页格式不变；正在进行的旧局无需迁移或重新落地。
- 每次调用时读取旧配置，未把配置冻结成启动快照；公共工厂本身不临时替换全局配置。
- 旧 processor、main、backend 调用入口及钩子不变；旧到期仍调用原版全局玩家 respawn。赛季 2 全区清场属于后续步骤，未在本步实现。
- 公共工厂可生成 `speedrun-season2/*` 键，但本步没有创建或调度真实赛季 2 比赛。
- Invader、claim、Ruin、中央九房以及全图 deposit/power bank 控制不改。

## 自动测试实际结果

全部使用本地测试配置和测试存档，没有部署线上或修改真实存档。

| 检查 | 结果 |
| --- | --- |
| TypeScript `tsc -b` | 通过 |
| 公共比赛入口、工厂及新增测试严格 ESLint | 通过 |
| 公共比赛专项：仅旧 mod / 双 mod | 各 15/15 |
| 旧赛季八组专项：仅旧 mod / 双 mod，逐组独立进程 | 各 80/80 |
| 赛季 2 骨架专项 | 20/20 |
| 默认完整测试，不启用赛季 mod | 667/667 |
| 18 个迁移函数体的源代码对照 | 仅配置、范围、日志前缀替换及两处等价 lint 表达式调整 |
| 下方只读旧比赛配置和键名检查，本地等价执行 | 正确输出旧档位和 `speedrun/*` 键 |

启用自定义赛季规则后的整包混跑仍不是全部通过：

- 仅旧 mod：761 项，739 通过、22 失败。
- 双 mod：781 项，759 通过、22 失败。
- 两份最终日志与第 1 步基线逐项比较，失败名称及顺序完全一致，没有新增失败。既有原版测试与赛季规则冲突等问题仍保留，不以本次重构掩盖。
- 复测暴露两项旧随机地形断言：布局可能正常连通，以及固定位置可能原本就是墙。分别固定样本、翻转 tile 后复测通过。早先同一测试目录并发进程造成测试锁清理冲突，最终整包结果改用独立配置目录重新执行，不采用锁冲突日志作为最终结果。

实际日志：`/private/tmp/xxscreeps-season2-step2.VK9smL`。最终整包日志在 `old-full/full-suite.log`、`dual-full/full-suite.log`；基线比较见 `failure-comparison.log`。

## 本地复测

构建和检查：

```bash
cd /Users/jason/workspace/nodejs/xxscreeps
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint --max-warnings 0 \
  packages/xxscreeps/mods/speedrun/race.ts \
  packages/xxscreeps/mods/speedrun/race-core.ts \
  packages/xxscreeps/mods/speedrun/race-core-test.ts
node --experimental-vm-modules packages/xxscreeps/xxscreeps.js test --sandbox unsafe
```

最后一行以仓库没有启用赛季 mod 的配置为前提，否则使用独立默认配置目录。

双 mod 专项在独立目录执行，不复制真实存档：

```bash
test_dir=$(mktemp -d /tmp/xxscreeps-season2-step2.XXXXXX)
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
node --experimental-vm-modules "$bin" test "race core"
node --experimental-vm-modules "$bin" test "mods/speedrun-season2"
for suite in "season-1 scope" "mods/speedrun" "ruin suppression" \
  "respawn cleanup" "race results" "race pages" "race restarts" "uniform rooms"; do
  node --experimental-vm-modules "$bin" test "$suite" || break
done
```

预期分别为 15/15、20/20，旧八组为 20、23、3、6、7、8、6、7 项全通过。去掉新 mod 后，公共专项仍为 15/15，旧八组仍全部通过。不在同一配置目录并发测试进程。

## 测试环境部署和手动验收

1. 更新前记录旧 `/speedrun` 页面的历史成绩、最好成绩，以及进行中比赛的 run、房间和开始 tick。保留正常部署前的存档快照。
2. 正常构建、部署并完整重启测试服务，保留原存档、旧 `speedrun` 配置和第 1 步的 mod 配置。**无新增配置、无数据迁移；不要 import、uniform-terrain、初始化地图或删除比赛键。**
3. 使用下方只读命令确认旧比赛适配器。示例容器名、工作目录按实际部署替换：

```bash
docker exec -w /data xxscreeps-test \
  /xxscreeps/node_modules/.bin/xxscreeps eval -e \
  'import("xxscreeps/mods/speedrun/race.js").then(r => JSON.stringify({ brackets: r.raceBrackets(), respawnAfter: r.respawnAfter(), due: r.dueRunsKey, racing: r.racingKey, run: r.runKey("100"), score: r.scoreKey(20000, "100:1"), rank: r.rankKey(20000), best: r.bestKey(20000), runs: r.playerRunsKey(20000, "100"), playerBrackets: r.playerBracketsKey("100") }, null, 2))'
```

预期档位及窗口为你的旧配置值，所有键均保持 `speedrun/*`。`100` 只是生成键名的示例，不会查询或写入该玩家；本命令不连接游戏存档。

4. 重新打开旧 `/speedrun`，核对历史和最好成绩未变。进行中比赛继续使用原 run 和开始 tick，倒计时随游戏 tick 继续；停服期间不推进，不因为升级而重新开始。若恰逢原定到期，正常结束不算丢失数据。
5. 在测试配置目录执行公共专项与骨架专项，分别应为 15/15 和 20/20。它们使用独立测试存档，不替换游戏存档。
6. 新 mod 不产生赛季 2 比赛、页面或地图变更。不要将没有赛季 2 榜单解释为本步失败。

### 可选：短窗口完整验证旧赛季

只在完整存档的测试副本中，将旧配置临时改为：

```yaml
speedrun:
  raceBrackets: [10, 20]
  respawnAfter: 30
```

其他旧配置保持原值；`speedrunSeason2` 保持不变。使用测试账号在旧区块重新落地，以新局开始 tick 为零点：

- 第 10、20 tick，仍拥有房间且达到 RCL 2 的玩家产生旧榜单成绩；RCL 不足则无成绩，符合旧规则。
- 第 30 tick，旧比赛进入原有到期 respawn 流程，随后房间 processor 执行退出，不自动放回 Spawn。
- 再落地时旧局数递增，已产生的成绩仍保留；无赛季 2 比赛。

完成后恢复旧配置并重启。不要在线上或仍有需要保留的活动比赛时改短档位；本步不要求为验证而重置现有玩家。

## 回滚

整套服务回滚到第 1 步版本并完整重启，配置和存档保持原样。不要仅替换一个编译文件造成新旧模块不一致。

比赛键及格式没有变化，无需迁移、删表、恢复地形或重置局数；停服时冻结的旧计时按存档继续。移除新 mod 并非本步必须操作。

## 用户确认

- [ ] 测试服务正常启动，旧配置及键名不变。
- [ ] 旧排行榜、历史、进行中的比赛正常。
- [ ] 公共比赛与骨架专项通过。
- [ ] 用户确认第 2 步通过，才开始第 3 步地图显式初始化。
