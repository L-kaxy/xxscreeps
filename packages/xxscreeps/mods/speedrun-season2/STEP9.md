# 第 9 步验收：独立计分与存储

日期：2026-10-13。用户确认第 8 步“通过 下一步”，本轮只实现第 9 步，自动测试后等待本步验收。**不接入赛季 2 自动重开、全区清场、排行榜 HTTP API 或页面。**

后续验收记录：用户确认“前面通过, 继续下一步”，第 9 步已通过。本文保留第 9 步交付时的范围；当前手动清场及中央九房 Extractor 保留规则见 [STEP10.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP10.md)；当前自动重开及完整榜单已交付，见 [STEP11-14.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP11-14.md)。

## 本步规则

- 新增赛季 2 `main` provider，仅在房间处理完成后的 shard tick 消费 `speedrun-season2/due`；没有地图 initializer，也不调用自动 respawn。
- 按 `speedrunSeason2.raceBrackets` 计分，默认 20000、40000。从存档读取落地房间控制器，不依赖玩家登录或客户端在线。
- 当前 run、活动赛季身份、房间范围和双重归属检查通过，且 `RCL ≥ 2` 才有成绩。分数沿用旧公式：已完成的控制器等级所需进度之和，加当前等级进度。
- 全部成绩及索引使用新前缀：
  - `speedrun-season2/score/<bracket>/<userId>:<run>`：每局每档位快照；
  - `speedrun-season2/rank/<bracket>`：该档位全部有效历史局；
  - `speedrun-season2/best/<bracket>`：每个账号一行最好成绩；
  - `speedrun-season2/runs/<bracket>/<userId>`：该玩家各局历史；
  - `speedrun-season2/brackets/<userId>`：有成绩的档位及其最好分数。
- 新增本赛季 `readLeaderboard`、`readPlayerRecords`、`readPlayerBrackets` 存储读取函数，可供 CLI 验收和后续 API 复用。只读新表，并按 E81 过滤后分页；排名沿用旧赛季零基序及同分排序。
- 比上局差也保留历史，不降低最好成绩；更好则更新最好成绩和档位索引。换赛季或重新落地不删除旧历史。
- 玩家级互斥沿用第 8 步。赛季 2 开启内部 `captureOnce`：已有快照的同一局同一档位，不因重复 tick、重放队列或并发任务改写第一次成绩。**不是新增 YAML 配置。**
- 旧赛季未启用 `captureOnce`，所有旧公开函数、键名、计分、自动重开和页面保持原语义。

不足 RCL、失去房间或读不到房间的到期项仍按旧逻辑消费，不在之后升级时补记该档位；未来档位仍可正常计分。最后档位消费后，新 racing 暂时保留，run 不写到期 `endedTick`，不清建筑、不自动退出，留给第 11 步接入。

## 文件与修改原因

| 文件 | 原因 |
| --- | --- |
| [新 main.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/main.ts) | 注册唯一的新赛季计分 tick hook；不带地图或到期重开逻辑 |
| [新 race.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/race.ts) | 导出独立成绩键、计分与历史/排名读取，开启新赛季快照防重放 |
| [旧 race-core.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race-core.ts) | 增加默认 false 的可选 `captureOnce`，在已有玩家锁内检查快照；旧适配器及纯 core 默认行为不变 |
| [新 index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts) | 将 `main` 加入 provider，其他依赖和 provider 保留 |
| [新 score-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/score-test.ts) | 27 项计分、存储、隔离、防重放、排名、真实处理器和真实进程重启测试 |
| [新 lifecycle-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/lifecycle-test.ts) | 第 8 步的阶段断言改为“到期消费计分项，但不自动 respawn”；其余开局和切换测试保留 |
| [新 test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts) | 导入专项，并检查真实启动链加载新增 main provider |
| [README.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/README.md)、[TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md)、[STEP8.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP8.md) | 记录第 8 步通过、当前实现范围与验收顺序 |

旧 main、backend、processor、配置及页面无须修改；claim/Ruin 和资源全图规则、Invader 区块规则均不变。

## 部署

1. 保存配置和完整测试存档快照，正常构建、部署并完整重启所有服务，确保 main 加载新增 provider。
2. 无新增配置、成绩迁移、地图重拍或清场操作。默认档位不变，`speedrunSeason2.respawnAfter` 仍未接入自动退出。
3. **只在测试副本验收，不提前开放正式赛季 2。** 新代码会消费第 8 步已建立的待计分队列。已有逾期项按当前快照记录实际采集 tick，不能还原历史档位时的房间状态，不要把这些中间阶段测试记录当正式赛事成绩。
4. 配置改档位不重排已有队列，短窗口验收需在修改配置、完整重启后正常 respawn 并重新落地。被切换终止的历史局不补记。

## 短窗口测试配置

保留其他配置，只在测试副本的现有节点修改，例如：

```yaml
speedrunSeason2:
  invaders: false
  respawnCleanup: true
  raceBrackets: [200, 400]
  respawnAfter: 400
```

完整重启，再正常落 E3N3。在落地 T 后的 T+200、T+400 采集；确保采集前达到 RCL 2。没有达到时该档位无成绩，是预期行为，不表示队列未执行。可按实际脚本速度延长档位；`[20,40]` 适合已经准备好控制器状态的快速测试夹具，不保证自然开局能在 20 tick 内升级。

### 可选：停服准备测试等级

如果需要快速得到正向成绩，可在**测试副本**正常落地后、首档位到期前停止全部服务，用以下 CLI 只修改 E3N3 的测试等级、进度和降级时间。将 `USER_ID` 改成实际测试账号 ID。它拒绝 main 仍在运行、归属/活动身份不符或已经到期的现场；不要在线上执行，也不要用来修改正式成绩。

```bash
xxscreeps eval -e '(async () => {
  const {Database, Shard} = await import("xxscreeps/engine/db/index.js");
  const {Mutex} = await import("xxscreeps/engine/db/mutex.js");
  const {config} = await import("xxscreeps/config/index.js");
  const {isCurrentSeasonRun} = await import("xxscreeps/mods/speedrun/race-lifecycle.js");
  await using db = await Database.connect();
  await using shard = await Shard.connect(db, config.shards[0].name);
  await using mutex = await Mutex.connect("game", shard.data, shard.pubsub);
  await using lock = await mutex.acquire();
  if (await shard.data.get("mutex/main") !== null) throw Error("stop every service first");
  const user = "USER_ID";
  const info = await db.data.hGetAll(`speedrun-season2/run/${user}`);
  const brackets = config.speedrunSeason2?.raceBrackets ?? [];
  if (info.room !== "E3N3" || info.endedTick !== undefined ||
      !await isCurrentSeasonRun(shard, "speedrun-season2", user, info)) throw Error("not the active E3N3 run");
  if (brackets.length === 0 || shard.time >= Number(info.startedTick) + Math.min(...brackets))
    throw Error("use a fresh run before its first bracket");
  const room = await shard.loadRoom("E3N3");
  if (!room.controller || room["#user"] !== user || room.controller["#user"] !== user)
    throw Error("fixture owner mismatch");
  room["#level"] = 3;
  room.controller["#progress"] = 1000;
  room.controller["#downgradeTime"] = shard.time + 100000;
  await shard.saveRoom(room.name, shard.time, room);
  await shard.copyRoomFromPreviousTick(room.name, shard.time + 1);
  await shard.save();
  return JSON.stringify({room:room.name, user, time:shard.time, level:3, progress:1000});
})()'
```

重新启动所有服务，等两档采集。没有进一步升级时，两档都应为 46200 控制点；若脚本继续升级，以采集时的 level/progress 和存储字段为准。测试结束后恢复完整测试快照。

## 只读成绩检查

在测试副本的服务端配置目录运行，不是在玩家 Game 控制台执行。将 `USER_ID` 替换为测试账号 ID：

```bash
xxscreeps eval -e '(async () => {
  const {Database, Shard} = await import("xxscreeps/engine/db/index.js");
  const {config} = await import("xxscreeps/config/index.js");
  const race = await import("xxscreeps/mods/speedrun-season2/race.js");
  await using db = await Database.connect();
  await using shard = await Shard.connect(db, config.shards[0].name);
  const user = "USER_ID";
  const info = await db.data.hGetAll(race.runKey(user));
  const brackets = race.raceBrackets();
  const results = [];
  for (const bracket of brackets) {
    results.push({
      bracket,
      current: info.run === undefined ? {} : await db.data.hGetAll(race.scoreKey(bracket, `${user}:${info.run}`)),
      board: await race.readLeaderboard(shard, bracket, 0, 10),
    });
  }
  return JSON.stringify({
    run: info, results,
    playerBrackets: await race.readPlayerBrackets(shard, user),
    history: await race.readPlayerRecords(shard, user, brackets),
    due: (await shard.data.zRangeWithScores(race.dueRunsKey, -Infinity, Infinity, {by:"SCORE"}))
      .filter(([, member]) => member.startsWith(`${user}:`)),
    racing: (await shard.data.zRangeWithScores(race.racingKey, -Infinity, Infinity, {by:"SCORE"}))
      .filter(([, member]) => member.startsWith(`${user}:`)),
  }, null, 2);
})()'
```

### 验收顺序与预期

1. **精确档位**：记录落地 T；第一档前没有本局该档成绩，第一档后有第一份快照、due 只剩下一档，第二档后两份快照且 due 为空。`startedTick` 为 T，`elapsed` 正常为档位长度，`tick` 为实际采集 tick。
2. **字段与索引**：快照的 room/run/user、level/progress、controlPoints 与本局一致；rank 收录历史局，best 每人一行，playerBrackets 和 history 都只包含新赛季结果。
3. **门槛失败**：另一次新局保持 RCL 1，第一档不出成绩，升级后不会补回第一档；若未来档位时已经 RCL 2，可正常出后档成绩。
4. **历史最好**：再正常 respawn、重新落地并重复短窗口采集。新 run 递增，历史保留；较差新局不降低旧最好成绩，较好新局更新最好成绩。同分规则和分页由专项测试覆盖。
5. **切换隔离**：正常切回旧赛季，先前新成绩仍可读取，但该新局的未到档位不再记分；旧计分和旧页面正常。不能从旧榜看到新成绩，也不从新存储读取旧历史。
6. **重启保持**：第一档后、第二档前完整重启。第一份快照、历史及队列保留，第二档继续正常采集；不会因重启清场或重开。
7. **阶段边界**：达到第二档和 `respawnAfter` 后，仍持有房间、建筑不被全区清除，racing 暂时保留且无到期 `endedTick`。这是第 9 步预期，不要求新 API/页面。

无需人工注入重复队列或修改分数来证明防重放；重复 tick、同一队列重放、并发采集及并发消费已由专项测试验证。正式部署前恢复测试配置，并按后续上线步骤处理测试数据，不要删除旧赛季成绩。

## 自动测试

均在临时配置、数据库和原版测试夹具运行，未访问线上。

| 测试 | 结果 |
| --- | --- |
| 新赛季计分、存储和隔离专项 | 27/27 |
| 第 8 步生命周期专项 | 22/22 |
| 既有赛季 2 配置/加载、落地、Invader、地图、封墙、全图规则 | 20/20、25/25、17/17、28/28、13/13、49/49，共 152/152 |
| 旧赛季及公共比赛（仅旧 mod / 双 mod） | 各 99/99 |
| 默认完整回归 | 667/667 |
| 仅旧 mod 完整混跑 | 744/765，21 项既有失败 |
| 双 mod 完整混跑 | 945/966，21 项既有失败 |
| TypeScript、本轮公共代码与赛季 2 严格 ESLint、diff 空白检查 | 通过 |

首次新专项为 24/27，三项失败均为夹具期望漏加 RCL 4 的当前 200 进度；正确分数是 180400，而非 180200。只修正这三项期望，没有修改计分公式；复测 27/27。首次日志保留于 `dual/scores.log`。

完整混跑的 21 项失败与第 8 步基线同名同序，没有新增失败，**不是整包全部通过**；对比见 [failure-comparison.log](/private/tmp/xxscreeps-season2-step9.VUK11z/failure-comparison.log)。没有为消除原版测试与赛季规则的既有冲突修改无关规则或原版测试。

首次独立地图/封墙回归出现 4 项既有 CLI 超时：地图一项框架 10 秒超时、两项子进程 8 秒 SIGTERM，封墙一项框架 10 秒超时。完整回归中的这些项目随后全部通过，串行独立复核地图 28/28、封墙 13/13；没有改地图代码或测试时限。首次日志及 `*.recheck.log` 均保留，不将首次失败隐去，也不保证负载下 CLI 用例永不超时。

文档的等级夹具和只读命令已原样提取，仅替换 USER_ID，在独立临时存档的真实落地 T=1 后执行；20/40 两档在 21/41 采集，均为 46200。第一档前无结果，两档后 due 为空但 racing 保留，重复只读输出逐字一致。到期后再执行夹具被正确拒绝，拒绝后的成绩读取结果仍一致。详情见 [validation.log](/private/tmp/xxscreeps-season2-step9.VUK11z/read/validation.log) 与 [read-after.log](/private/tmp/xxscreeps-season2-step9.VUK11z/read/read-after.log)，不涉及线上存档。

日志目录：[step9.VUK11z](/private/tmp/xxscreeps-season2-step9.VUK11z)。

仓库根目录：

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/eslint/bin/eslint.js \
  packages/xxscreeps/mods/speedrun/race-core.ts \
  packages/xxscreeps/mods/speedrun-season2 --max-warnings 0
```

测试副本配置目录：

```bash
xxscreeps test "season-2 scores"
xxscreeps test "season-2 lifecycle"
xxscreeps test "mods/speedrun-season2"
xxscreeps test "race core"
xxscreeps test "race results"
xxscreeps test "race pages"
xxscreeps test "race restarts"
```

## 回滚

停服回退第 8 步整套代码并完整重启所有服务，新增 main provider 随之移除。无需迁移或删除任何旧成绩；新成绩表可保留，旧版本不会继续采集或读取它们。

回滚不撤销已经写入的新成绩，也不复原已消费的 due。要准确恢复本轮测试现场，停服恢复测试前完整存档快照，而不是只恢复某张成绩表或地图。不要把已经逾期的中间阶段队列作为正式赛事回放。

## 用户确认

- [ ] 正常短档位计分、门槛和历史最好成绩符合预期。
- [ ] 新旧成绩表、读榜和切换隔离正常，旧赛季不受影响。
- [ ] 重启保留已记成绩，待记档位继续执行；没有提前自动退出或清场。
- [ ] 用户明确通过后，才开始第 10 步手动 respawn 全区清场。
