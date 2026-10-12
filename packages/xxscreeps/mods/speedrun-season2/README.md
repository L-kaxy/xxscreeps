# Speedrun 赛季 2 扩展方案

在同一 shard 上保留赛季 1，并新增赛季 2。两个赛季共用游戏引擎和账号体系，复用基础玩法逻辑，但各自按区块运行地图规则、Invader 控制、比赛计时和计分，并使用独立配置、存储和排行榜页面。

方案确认日期：2026-10-12；进度更新：2026-10-13。第 0～4 步（含外围出口封墙）已由用户验收通过。第 5 步在原有 `processor` provider 中接入按新区块控制的周期 Invader 开关，验收见 [STEP5.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP5.md)。新 mod 仍注册 `backend`、`config`、`processor`、`test` provider，地图和补墙仍是显式 CLI，不在启动时拍图。独立 claim/Ruin、比赛、清场和页面尚未接入。**中间步骤只在测试副本初始化、落地，不在线上开放未完成的赛季 2。** 前序验收见同目录步骤文档及 [封墙补充文档](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP4-HIGHWAYS.md)。

逐步开发顺序和验收进度见 [TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md)。每步完成自动测试后交付用户验收，用户确认通过才继续下一步；当前停在第 5 步，第 6 步尚未开始。

## 赛季范围和规则

| 项目 | 赛季 1 | 赛季 2 |
| --- | --- | --- |
| mod | `xxscreeps/mods/speedrun` | `xxscreeps/mods/speedrun-season2` |
| 区块 | `W1N1～W9N9`，共 81 房 | `E1N1～E9N9`，共 81 房 |
| 配置根节点 | `speedrun` | `speedrunSeason2` |
| 初始落地 | 保持旧规则，但只处理旧区块 | 只允许在 `E3N3` 落地 |
| 地图 | 保留现有旧赛季地图 | 平移原版私服初始地图 |
| 中央九房 | 旧区块内继续关闭、封墙 | 不关闭、不封墙，正常运行 |
| 统一地形命令及恢复 | 只作用于旧区块 | 不参与旧赛季的统一地形操作 |
| Invader | 按旧区块和旧配置控制 | 按新区块和独立配置控制 |
| 玩家 respawn | 清掉该玩家全部房间的对象并释放控制器 | 同样清掉该玩家全部房间 |
| respawn 地图清场 | 保持现有清理规则 | 清掉新区块内所有人造建筑 |
| 比赛状态与成绩 | 保留 `speedrun/*` | 使用 `speedrun-season2/*` |
| 排行榜页面 | `/speedrun` | `/speedrun-season2` |

区块判断应由统一的房间范围函数负责，使用准确的房间名和数值范围，不用模糊前缀或字符串大小比较。两个赛季的 `placeSpawn`、比赛启动、计分和实时榜都检查各自区块，不再由旧 mod 全局接管。

赛季 2 仅允许一个玩家正常落地，继续使用现有房间占用和玩家 presence 检查，不增加单人锁、排队、房间实例或多人并行机制。两个赛季均保持不能通过 `claimController` 占领其他房间的玩法。

## 原版地图来源和平移方式

使用原版私服发行包中的初始数据库：

```text
/Users/jason/workspace/nodejs/screeps-server-mockup/node_modules/@screeps/launcher/init_dist/db.json
```

该文件包含 `W0N0～W10N10` 的 121 个房间，地形位于 `rooms.terrain`，初始房间对象位于 `rooms.objects`。`screeps-server-mockup/assets/rooms.json` 只有九个经过修改的示例房间，不作为本次地图来源。

第 3 步已将所需 81 房提取到 [original-map.json](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/assets/original-map.json)。运行和部署不依赖上述开发机目录；提取范围、资源字段及许可说明见 [资源说明](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/assets/README.md)。

取原图的 `W1N1～W9N9`，沿真实世界坐标向东平移 11 个房间，生成赛季 2 的 81 房：

```text
W{x}N{y} → E{10-x}N{y}，其中 1 ≤ x,y ≤ 9

W9N9 → E1N9
W7N3 → E3N3
W1N1 → E9N1
```

这不是镜像。固定资源保留原版墙、沼泽、平地和对象的 `(x, y)` 坐标；只改变对象所属房间及必须随之更新的房间引用。按 2026-10-13 追加要求，实际地图仅在新区块朝封闭 highway 的外围边界增加地形墙，内部布局和对象坐标不变。内部对象 ID 需保证不会与现有世界对象冲突。

原图 `W7N3` 的初始自然对象如下，平移后用于 `E3N3`：

| 对象 | 坐标 |
| --- | --- |
| Source | `(41, 3)` |
| Source | `(38, 6)` |
| Controller | `(36, 18)` |
| Mineral | `(24, 29)` |

直接转换并拍入原版地形及初始地图对象布局，不随机生成、不修出口、不做额外的连通性或落地空间校验。不导入原始数据库中的玩家账号、代码、机器人 Spawn、排行榜或其他比赛状态。

边界规则已按追加要求调整：外围普通房间朝封闭 highway 的一整条 50 格边界封为地形墙，并同步移除对应 exit 标记。四条 highway 全部关闭时，涉及 32 房、36 面；highway 本身不改地形或开放状态。内部连接不封，不增加额外跨区 intent 或 portal 检查。赛季 2 的中央九房 `E4N4～E6N6` 保留原版地图，不被关闭或封墙。新初始化自动包含此处理；已有地图停服执行 `season2-map --seal-highways --server-stopped` 补墙，不重拍、不动建筑。

## 旧地图备份和区块化改造

任何写入地图的操作之前，先备份当前旧赛季现场，包括地形、房间数据及开放房间列表；上线回滚同时保留持久化存储快照。现有 `speedrun/terrainBackup` 是旧改图流程的历史备份，不等于本次上线前的现场备份，两者不能混用。

新地图通过显式初始化操作写入新区块，不整图重新 import，不在每次服务启动时重新拍图。首次初始化涉及房间对象，停服执行，完成后统一启动服务。

旧赛季下列操作必须收窄到 `W1N1～W9N9`：

- 中央九房关闭与封墙，仅处理 `W4N4～W6N6` 及旧区块内相关地形。
- `uniform-terrain` 的房间选择、地形和对象写入，只处理旧区块。
- 原有统一地形流程中的 highway 开口调整，不再跨出旧区块改写其他房间。
- `uniform-terrain --restore` 按旧区块合并恢复地形及对应房间，不能直接把整份旧 terrain blob 写回并抹掉新区块。

旧赛季的当前地图、玩家建筑和历史成绩不因新增赛季而重置。初始化赛季 2 只修改新区块及必要的地图元数据。

## 独立配置

赛季 2 提供自己的 `config.ts` 和配置 schema，以 `speedrunSeason2` 为根节点。现有 `speedrun` 根节点和旧配置名称保持兼容。

配置示意如下，两个赛季根节点独立；deposit 和 power bank 是例外，继续由旧配置中的全图开关统一控制，赛季 2 不再另设对应开关：

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/speedrun
  - xxscreeps/mods/speedrun-season2

speedrun:
  invaders: false
  deposits: false
  powerBanks: false
  ruins: false
  respawnCleanup: true
  raceBrackets: [20000, 40000]
  respawnAfter: 40000
  claimController: false
  closeCenterNine: true
  wallSectorCores: true

speedrunSeason2:
  invaders: false
  ruins: false
  respawnCleanup: true
  raceBrackets: [20000, 40000]
  respawnAfter: 40000
  claimController: false
```

赛季 2 的基础默认值先沿用旧赛季的玩法，但由自己的 defaults 定义，不能在运行时回退读取 `config.speedrun`。例如，只修改 `speedrun.invaders`，不能影响新区块；只修改 `speedrunSeason2.invaders`，不能影响旧区块。

两个配置中的 `respawnCleanup` 使用各自赛季的清场实现：旧赛季保持原有语义，新赛季清理整个新区块的人造建筑。赛季 2 不继承旧赛季中央九房和统一地形规则。

配置进入 runner sandbox 时也要保留赛季区分，不能让两个 mod 反复覆盖同一个全局开关，导致后加载者决定整个世界的行为。

## Invader 按区块独立控制

旧实现按 `speedrun.invaders` 清零房间采集预算的行为需要收窄。控制依据是 Invader 生成所在房间，而不是账号：

| 房间 | 配置来源 |
| --- | --- |
| `W1N1～W9N9` | `speedrun.invaders` |
| `E1N1～E9N9` | `speedrunSeason2.invaders` |
| 两个区块以外 | 不施加这两个赛季的 Invader 开关 |

`false` 关闭所属区块的周期入侵生成，`true` 恢复该区块的原版周期生成。旧赛季不得再清零新区块的预算，否则赛季 2 即使启用 Invader 也不会生效。实现时注意原版生成器与预算清理的执行顺序，避免禁用后仍因首次处理的旧预算生成一波入侵。

该开关延续旧配置控制周期生成的含义，不删除已有 Invader，也不关闭 Source Keeper；赛季 2 中央九房的原生机制继续运行。第 5 步明确：主动请求 Invader 的 `/api/game/create-invader` 及 `requestInvader` 内部 intent 保持原规则，不跟随两个周期生成开关；没有添加 API 包装或删除 NPC 的逻辑。

其他复用的基础玩法钩子也要避免全局覆盖，例如旧 mod 对 Ruin 插入的包装，应按房间选择对应赛季配置。**deposit 和 power bank 生成开关明确保留全图生效**：由 `speedrun.deposits` 和 `speedrun.powerBanks` 统一控制，包括 highway、新旧赛季及其他区块；关闭只阻止新增，不删除已有资源。赛季 2 不叠加资源生成包装或独立开关。

## 落地和比赛生命周期

API 层与实际 `placeSpawn` processor 共用赛季范围和落地限制：

1. 旧区块由旧赛季处理，保留原有房间占用、坐标、冷却等检查。
2. 新区块只有 `E3N3` 能落地，其他 80 房拒绝初始落地。
3. 一次落地只能由一个赛季启动比赛，不能同时写入两套 run 和定时队列。
4. 必须确认实际落地成功后，才以落地 tick 启动比赛。
5. 拒绝落地不产生比赛状态，不更新落地冷却。

复用比赛逻辑时显式传入赛季配置、区块与存储前缀，不通过临时修改全局配置切换赛季，也不让两个 mod 无条件叠加包装 `placeSpawn`。

玩家可在重开后选择另一个赛季。切换时终止上一赛季的活动 run，保留已记录的历史成绩。到期任务在整体 respawn 前必须核对当前活动比赛，防止旧赛季过期任务清掉玩家的新赛季比赛。

初期赛季 2 沿用旧赛季默认的 20k、40k 计分档位和 40k 自动重开窗口，但从独立配置读取。账号、代码、Memory 和 GCL 仍共用，不建立独立账号体系。

## Respawn 和赛季 2 全区清场

玩家退出和地图清场是两项操作。两个赛季的玩家退出都可复用现有整体 `respawnPlayer`：清掉该玩家所有房间的对象、释放控制器，并保持现有旗帜处理。无需把玩家整体 respawn 限定在赛季区块内。

地图清场则按触发本次退出的赛季执行：

- 赛季 1 沿用原有建筑清理范围和规则。
- 赛季 2 在手动 respawn 或到期自动 respawn 时，清理 `E1N1～E9N9` 全部 81 房的人造建筑，不限于 `E3N3`，也不限于玩家的 presence 房间。
- 赛季 2 清场不按建筑 owner 过滤，无主的 Road、Container、Wall 以及其他玩家留下的人造建筑同样清掉。
- 人造建筑的 Construction Site 一并清理，避免下一局继承施工残留。
- Source、Mineral、Controller、Keeper Lair 等原生对象保留；地形不重新生成，不恢复为旧赛季统一地形。

人造建筑清理应使用明确的建筑类型分类，不能简单删除所有带 `hits` 的对象或所有 `Structure`。Extractor 属于人造建筑；原版预置 Extractor 也按该分类清理。Portal、Power Bank 等世界对象不按玩家建筑处理。

最终计分与清理的顺序为：

```text
采集到期成绩
→ 结束本局
→ 玩家整体 respawn
→ 所属赛季地图清场
→ 玩家下一次成功落地启动新局
```

建筑清理不能因普通摧毁生成可继承的 Ruin 而留下本局建筑资源。清理通过正常房间 processor 和内部 intent 完成，覆盖没有玩家 presence、已休眠的房间，不在线直接写房间 blob。确认清场完成后再允许下一局落地，旧清理任务不得继续清掉新局建筑。

## 独立成绩存储和页面

旧赛季保留现有键名。新赛季使用完整的新命名空间，而不是只分离最终成绩：

```text
speedrun-season2/run/<userId>
speedrun-season2/score/<bracket>/<runId>
speedrun-season2/rank/<bracket>
speedrun-season2/best/<bracket>
speedrun-season2/runs/<bracket>/<userId>
speedrun-season2/brackets/<userId>
speedrun-season2/due
speedrun-season2/racing
```

沿用现有存储结构：run、score、rank、best、玩家历史索引放在账号级 `db.data`；due 和 racing 放在 `shard.data`。这里的独立表是独立 hash、sorted set 等存储键，不需要引入 SQL 数据库。

新页面及接口独立提供：

```text
/speedrun-season2
/api/speedrun-season2/leaderboard
/api/speedrun-season2/records/:user
/api/speedrun-season2/racing
```

旧 `/speedrun` 和 `/api/speedrun/*` 不变，旧成绩不迁移、不改名，也不作为赛季 2 的最好成绩或局数来源。两个排行榜和实时榜只读取本赛季的状态与记录。

旧活动任务若指向旧区块之外，应停止计分和到期清理。若已有历史成绩指向区块外，保留原始数据，但读榜时按本赛季区块过滤，不静默删掉历史数据。

## 后续模块划分

目录采用现有 mod provider 结构，后续按需新增文件：

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 声明 mod manifest 和依赖，使旧基础逻辑先加载 |
| `config.ts` 及 schema | 独立配置类型、默认值和 schema |
| `rooms.ts` | 赛季 2 区块判断和落地房间限制 |
| `processor.ts` | 按区块处理玩法、落地、Invader 和清场 intent |
| `respawn.ts` | 赛季 2 全区人造建筑清理 |
| `race.ts` | 使用独立前缀的比赛状态、计分和读榜 |
| `main.ts` | 赛季 2 的计分与到期重开任务，不封墙、不关闭中央九房 |
| `backend.ts` 及 `page.ts` | 独立榜单 API、页面和客户端入口 |
| `driver.ts` 及 `game.ts` | 独立配置传入 sandbox 及游戏 API 限制 |
| 地图初始化工具及静态资源 | 导入原版地图并按平移映射写入新区块 |
| `test.ts` | 两个赛季的隔离与回归测试 |

旧赛季作必要的区块化和复用逻辑调整，不复制出两套互相竞争的全局钩子。共用逻辑接收显式赛季参数，两套 provider 分别注册自己的区块、配置、存储和接口。

地图源数据后续固定为仓库内的静态资源，部署时不依赖开发机的 `screeps-server-mockup` 绝对路径。第 1 步 manifest 仅声明已实现的 `config` 和 `test`，不注册尚未实现的运行 provider，避免骨架加载时产生地图或玩法修改。

## 实施顺序和验收

实施顺序：

1. 备份旧赛季现场。
2. 将旧地图规则、基础玩法钩子、Invader、落地与比赛处理按旧区块收窄。
3. 建立赛季 2 的独立配置和共享逻辑的显式赛季参数。
4. 将原版地图平移写入新区块。
5. 实现赛季 2 落地、计分、整体 respawn 和全区人造建筑清理。
6. 新增独立榜单 API、页面和入口，完成双赛季回归测试。

验收至少覆盖：

- 旧地图和旧赛季规则不因新 mod 改变，旧统一地形及恢复不覆盖新区块。
- `E3N3` 对应原版 `W7N3`，房内坐标与地形不镜像。
- 赛季 2 中央九房保持开放且未封墙。
- 新区块非 `E3N3` 落地失败，不启动比赛，也不影响冷却。
- 成功落地只启动本赛季 run；计时队列、实时榜和历史榜不混读、混写。
- Invader 两个配置分别开关的四种组合都正确，区块外不受影响。
- 其他独立配置不会被旧 mod 的全局包装覆盖。
- deposit 和 power bank 生成在两个赛季区块及 highway 上均遵循 `speedrun` 下的全图开关；两个开关独立生效，不删除已有资源。
- 手动和自动 respawn 均完成玩家整体退出；赛季 2 同时清掉全区人造建筑和施工点，保留原生对象及地形。
- 无 presence 的房间同样被清场，旧清理任务不误删下一局建筑。
- 切换赛季后，上一赛季的过期任务不再触发整体 respawn。
- 重启不会重新拍图或清空成绩；只启用旧 mod 的部署仍能运行旧赛季。
