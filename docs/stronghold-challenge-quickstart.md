# 5 级要塞挑战部署与运维

这份文档介绍 `xxscreeps/mods/stronghold-challenge` 的玩法、离线地图准备和成绩查询。每组两间房：玩家在左房落地，从右房击破本局指定的 5 级 Invader Core，以耗时 tick 排名。

适用对象：使用本仓库代码部署挑战服的运营者。已有 Speedrun 服可以切换，但需要先清空玩家参与状态、停服，再准备挑战地图。

## 1. 玩法规则

| 项目 | 行为 |
|---|---|
| **开始比赛** | 在空闲组的左房成功放置第一个 Spawn，开始一局；左房立即获得 RCL 8，并补齐为 3 个 Spawn |
| **挑战目标** | 落地时重置右房，立即部署 `bunker5` 模板的 5 级要塞，核心在 `(25, 25)`；没有部署等待期 |
| **计分** | 击破本局指定核心时记录 `finishedTick - startedTick`；耗时越小排名越高，每位玩家的最好成绩进入总榜，所有成功记录可查询 |
| **截止时间** | 使用要塞原生寿命：`Math.round(75000 * (0.9 + Math.random() * 0.2))` tick，约 67500–82500 tick，每局随机；到期自动 Respawn |
| **成功后** | 立即保存成绩，房组保留到手动 Respawn 或本局原截止时间；击破后从「进行中」列表移出 |
| **重开** | 客户端 Respawn、`manage user respawn` 和到期自动 Respawn 都重置整个房组：左房交还，右房清场；下一局从玩家再次落地开始 |

寿命公式见 [Screeps 官方部署算法](https://github.com/screeps/engine/blob/master/src/processor/intents/invader-core/stronghold/stronghold.js)。计时从落地的游戏 tick 开始，不按墙上时钟计时。只有**截止时间之前**击破指定核心才入榜：清掉其他建筑、核心自然坍塌、手动重置都不算成功；在截止 tick 击破也不入榜。成功记录在 Respawn 后仍保留。

左房的 Spawn 生成 Creep **免费用能量**，仍遵守身体大小、名称和孵化等生成规则。每个 Spawn 的能量存储仍是普通的 **300 容量**，生成不检查或扣除这份能量。左房 Spawn 常驻 5 级 `PWR_OPERATE_SPAWN`，无需 Power Creep 施放。

左房 Spawn 成功孵化出的 Creep 自动获得以下 T3 boost；`CLAIM` 不加 boost：

| 部件 | Boost |
|---|---|
| `ATTACK` | `XUH2O` |
| `RANGED_ATTACK` | `XKHO2` |
| `HEAL` | `XLHO2` |
| `TOUGH` | `XGHO2` |
| `MOVE` | `XZHO2` |
| `CARRY` | `XKH2O` |
| `WORK` | `XZH2O`，拆建筑用 boost |

## 2. 地图布局

地图准备要求世界中有**恰好一个完整的 9×9 扇区内部**，共 81 间房。每行按左右配对组成 4 组，最后一列闲置，因此共 **36 组双房场地 + 9 间闲置房**。默认导入世界的外围房仍存在，不计入这 81 间内部房。

每组左房有中立控制器，供玩家落地；右房没有控制器。房间内部为平原，边界封墙，只有同组左右房之间的 `y = 21…28` 出口连通。其他房组、闲置房和外围房由墙隔离，玩家只能在自己的双房场地内行动。

`prepare-stronghold` 会重写世界地形及房间对象；首次准备前保存一份原世界备份，供 `--restore` 恢复。它要求所有玩家已退出世界，并且所有服务停止。多扇区或不完整的 9×9 地图会被拒绝。

## 3. Docker 部署

以下命令从已检出本仓库代码的目录执行。数据目录示例为 `~/xxscreeps-data`，容器名为 `xxscreeps`。

### 3.1 构建与首次导入

```bash
docker build . -t xxscreeps
mkdir -p ~/xxscreeps-data
docker run -it --rm -v ~/xxscreeps-data:/data xxscreeps import
```

已有存档跳过 `import`。如果服务正在运行，先让所有玩家 Respawn，并等交还完成，再停止所有使用同一数据目录的服务。管理员可以逐个执行；把示例中的 `alice` 替换为目标用户名或用户 ID：

```bash
docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps manage user respawn alice
docker stop xxscreeps
```

### 3.2 切换规则集

编辑 `~/xxscreeps-data/.screepsrc.yaml`。保留原有基础和登录模块，将 `xxscreeps/mods/speedrun` **替换**为 `xxscreeps/mods/stronghold-challenge`；这两个规则集不能同时启用。

```yaml
mods:
  - xxscreeps/mods/classic
  - xxscreeps/mods/backend/cookie
  - xxscreeps/mods/backend/email
  - xxscreeps/mods/backend/password
  - xxscreeps/mods/backend/steam
  - xxscreeps/mods/stronghold-challenge
```

基础依赖由模块声明加载。挑战计分、Spawn 加成和效果展示属于本模块，只有配置启用 `stronghold-challenge` 时才加载；原有 `speedrun:` 配置不控制这套玩法。切回原玩法前仍需先恢复已经准备过的地图（见 §4）。

### 3.3 离线预检与准备

保持服务停止，先预检，再实际写入：

```bash
docker run --rm -v ~/xxscreeps-data:/data xxscreeps prepare-stronghold --dry-run
docker run --rm -v ~/xxscreeps-data:/data xxscreeps prepare-stronghold
```

默认 121 房世界预检会输出：

```text
Would prepare 36 pairs, 9 unused interior rooms, 121 rooms in the world
```

实际准备成功时开头是 `Prepared`。`--dry-run` 不写地图；已经准备过的世界会拒绝再次准备，需先 `--restore`。命令默认选配置中的第一个 shard，也可加 `--shard <名称>` 指定目标。

### 3.4 起服

首次创建服务容器：

```bash
docker run -d --name xxscreeps --restart unless-stopped \
  -p 21025:21025 -v ~/xxscreeps-data:/data xxscreeps start
```

如果前面只是停止了已有容器，用 `docker start xxscreeps` 重启；代码更新后应使用新镜像重建容器。

启动时服务会检查地图已经 prepared。只修改 `mods:`、没有实际执行地图准备，会报错并拒绝开始游戏。

## 4. 重开与恢复原世界

比赛中玩家可以使用客户端 Respawn 重开，管理员也可以执行：

```bash
docker exec -i xxscreeps /xxscreeps/node_modules/.bin/xxscreeps manage user respawn alice
```

命令排入交还意图，在游戏继续运行后处理。它会重置整组房间，清掉该组残留物件；服务不会替玩家放置下一局的 Spawn。期限结束时走相同的 Respawn 流程，即使玩家已经成功也会交还。

要撤销挑战地图，先让所有玩家 Respawn，等交还完成，停止所有服务；**保持挑战模块启用**执行恢复：

```bash
docker stop xxscreeps
docker run --rm -v ~/xxscreeps-data:/data xxscreeps prepare-stronghold --restore
```

恢复会还原首次准备之前的地形、房间对象和开放房间集合，而不是保留比赛期间的建设。恢复后可以重新准备挑战地图；若要回到原玩法，先修改 `mods:` 移除挑战模块，再启动。恢复已撤销 prepared 标记，直接以挑战模块起服会被拒绝。

`--restore` 同样要求无人参与、服务离线。没有备份时只报告 `No stronghold challenge backup to restore`。地图恢复不删除排行榜历史。

## 5. 成绩页面与 API

浏览器打开 `http://<host>:21025/stronghold-challenge`。页面显示每位玩家最好成绩、左房和右房位置、完成时间，以及进行中局的已用 tick 与剩余 tick；点击玩家查看全部成功记录。页面每 20 秒刷新，耗时仍以服务端游戏 tick 为准。

| 接口 | 内容 |
|---|---|
| `GET /api/stronghold-challenge/leaderboard?offset=0&limit=25` | 每位玩家最好成绩；`count` 是上榜玩家数，`rank` 从 0 开始，`score` 是耗时 tick；`limit` 为 1–100 |
| `GET /api/stronghold-challenge/records/<userId>` | 指定玩家全部成功记录，按耗时升序；这里的 `rank` 是该记录在所有成功局中的排名，从 0 开始 |
| `GET /api/stronghold-challenge/racing` | 当前仍在挑战的局；返回服务器 `time`、`tickSpeed`，以及房组、目标核心、`elapsed`、`left` 和截止 tick |

成绩记录包含 `runId`、`room`、`targetRoom`、`startedTick`、`finishedTick`、`elapsed` 和入榜时间 `at`。排行榜按 shard 分开保存。胜局会从 `racing` 移出，但其原期限仍有效。

## 6. 部署后检查

1. 离线预检和准备都报告 36 组、9 间闲置内部房；服务启动通过 prepared 检查。
2. 选空闲左房落地，确认 RCL 8 和 3 个 Spawn；同组右房已有立即部署的 5 级核心与要塞建筑。
3. 生成一个 Creep，确认无需提供生成能量，孵化完成后对应部件带上述 boost；`WORK` 为 `XZH2O`，`CLAIM` 无 boost。
4. 打开成绩页面，确认进行中列表显示正确的两房位置、已用 tick 和剩余 tick。真实击破指定核心后，核对耗时成绩与玩家记录。
5. 手动 Respawn，等交还完成，确认左房中立、右房清空；再次落地开始新局，历史成功记录仍可查询。

准备和恢复都会检查玩家参与状态。若提示仍有玩家在某房，先在正常运行的游戏中交还该玩家，等意图处理完，再停服重试。
