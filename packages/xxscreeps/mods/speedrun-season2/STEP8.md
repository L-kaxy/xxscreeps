# 第 8 步验收：独立开局与跨赛季切换

日期：2026-10-13。用户确认第 6、7 步“验证通过, 下一步”，本轮只实现第 8 步。**赛季 2 计分、全区清场、自动重开和排行榜接口/页面尚未接入**，仍只在测试副本验收。

## 本步行为

- E3N3 的原版 `placeSpawn` 实际交接成功后，才写 `speedrun-season2/run/<userId>`，以本次 `Game.time` 为 `startedTick`，分别建立 `speedrun-season2/due`、`speedrun-season2/racing`。
- 只读取 `speedrunSeason2.raceBrackets`；默认仍为 20000、40000。API 接受请求但尚未处理时不启动比赛，拒绝落地或重复对已占用房间落地不新增 run。
- W81 成功落地只启动赛季 1；E3N3 成功落地只启动赛季 2。两赛季分别递增自己的 run 编号，即使都为 `100:1`，也不会混用队列或成绩表。
- 双向切换会标记上一赛季当前 run 的 `endedTick`，移除该 run 的 due/racing；不删除、覆盖任何历史成绩或排名索引，不影响其他玩家。
- 成功落到两个区块以外时，结束两赛季当前计时，不启动任何赛季。目标赛季 `raceBrackets: []` 时也结束上一赛季，但不建立新 run/队列。
- 新增账号级 `speedrun/active/<userId>` JSON，仅保存活动比赛身份，不存成绩。校验 namespace、shard、run、room、startedTick、active；显式停止后保留 inactive 标记，不删除后误认成旧版比赛。
- 旧版赛季 1 没有该标记的进行中比赛仍兼容，无需批量迁移。导入模块/重启不自动写新比赛或补拍地图，也不追认此前已经落地的赛季 2 玩家。
- 同一玩家的启动、停止、计分及旧赛季到期任务使用数据库互斥，避免检查与切换之间交错写入；这是内部状态同步，**不是新增落地人数限制、排队或实例**。
- 赛季 1 原有计分和自动重开继续运行；在写成绩/排队整体 respawn 前检查活动身份，重放的旧队列不能作用于新赛季。赛季 2 后续到期处理将复用同一校验。

本步不清全区建筑，不改变普通玩家全局 respawn、claim/Ruin、Invader 或资源规则。赛季 2 的 due 即使到期也不会被本步消费，`respawnAfter` 暂不驱动赛季 2 自动重开；不能把它当完整赛季开放。

## 文件与修改原因

| 文件 | 原因 |
| --- | --- |
| [旧 race-lifecycle.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race-lifecycle.ts) | 新增懒注册的真实赛季协调层、持久化活动身份、玩家级互斥和双向停止；不混存成绩 |
| [旧 race-core.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race-core.ts) | 为真实赛季增加可选活动校验和计分/到期互斥；直接使用纯 core 的独立实例保持原行为 |
| [旧 race.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/race.ts) | 接入协调层，保留全部旧公开函数、键名和结果格式，防止旧计时影响新赛季 |
| [旧 processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/processor.ts) | 成功落在旧区块时交给协调层处理，即使旧档位为空也能结束新区块旧计时 |
| [新 race.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/race.ts) | 使用独立配置、区块和 namespace，仅导出开局、停止及状态/队列，不提前开放计分、重开或读榜 |
| [新 processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/processor.ts) | 原版落地成功后才启动赛季 2；区块外合法落地停止旧的赛季 2 计时 |
| [新 lifecycle-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/lifecycle-test.ts) | 22 项专项，覆盖真实处理器切换、独立队列、旧任务重放、历史保留、并发、禁用档位和真实进程重启 |
| [新 spawn-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/spawn-test.ts) | 原 25 项落地测试更新成功后的比赛状态断言；保留全部拒绝和原版 API 校验 |
| [新 test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts)、[index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts) | 导入专项并更新阶段说明；provider 不变，没有新增 main/tick provider |
| [README.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/README.md)、[TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md)、[STEP6-7.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP6-7.md) | 更新用户验收与当前实现边界 |

## 部署操作与配置

1. 保留配置和完整测试存档快照，正常构建、部署，**所有服务完整重启**，不要混用旧 main 与新 processor。
2. 没有新增配置。两个 mod、两套 `raceBrackets` 保持现有配置；第 6、7 步删除的 `speedrunSeason2.claimController`、`speedrunSeason2.ruins` 不要加回来。
3. 不需要重新初始化地图、补墙、清空队列、迁移成绩或批量建立 active 标记。
4. 仅新代码下实际成功的下一次落地才建立新赛季时钟。测试副本已有 E3N3 玩家，需要正常 respawn、等待退出完成，再重新落地；重启本身不会自动给其补开局。
5. 赛季 2 自动计分、自动重开、81 房建筑清场和页面留到后续步骤。临时缩短赛季 2 的档位只会改变本步队列时间，不会产生成绩或自动退出。

## 只读状态检查

在测试副本的配置目录使用服务端 CLI，不是在玩家 Game 控制台运行。将 `USER_ID` 改为测试玩家的账号 ID；命令不启动/停止比赛，不修改队列。

```bash
xxscreeps eval -e '(async () => {
  const {Database, Shard} = await import("xxscreeps/engine/db/index.js");
  const {config} = await import("xxscreeps/config/index.js");
  await using db = await Database.connect();
  await using shard = await Shard.connect(db, config.shards[0].name);
  const user = "USER_ID";
  const result = {};
  for (const season of ["speedrun", "speedrun-season2"]) {
    result[season] = {
      run: await db.data.hGetAll(`${season}/run/${user}`),
      due: (await shard.data.zRangeWithScores(`${season}/due`, -Infinity, Infinity, {by:"SCORE"}))
        .filter(([, member]) => member.startsWith(`${user}:`)),
      racing: (await shard.data.zRangeWithScores(`${season}/racing`, -Infinity, Infinity, {by:"SCORE"}))
        .filter(([, member]) => member.startsWith(`${user}:`)),
    };
  }
  const current = await db.data.get(`speedrun/active/${user}`);
  result.active = current === null ? null : JSON.parse(current);
  return JSON.stringify(result, null, 2);
})()'
```

默认档位下，如果 E3N3 首次成功落地 tick 为 T：

- 新 run：`run: "1"`、`room: "E3N3"`、`startedTick: String(T)`，无 `endedTick`。
- 新 racing：`[T, "<userId>:1"]`；新 due：`[T+20000, "<userId>:1:20000"]`、`[T+40000, "<userId>:1:40000"]`。
- active：`namespace: "speedrun-season2"`、`active: true`、房间/tick/run 与新 run 一致。
- 旧 run 若存在，则保留原字段并有 `endedTick`；该旧当前 run 的 due/racing 不再存在。更早的旧队列残项可能仍存在，但其 run 身份已无效，不能计分或重置当前玩家。

## 手动验收

1. **原赛季兼容**：测试玩家正常落在 W81 开放房间，旧 run/due/racing 和旧成绩采集正常；赛季 2 不新增 run。已有旧历史成绩仍可通过旧页面读取。
2. **新赛季开局**：普通 respawn 后等待玩家退出，再落 E3N3。用上面命令验证准确落地 tick、两套独立键、两条新 due 和一个新 racing；旧时钟结束。
3. **失败不启动**：先记录状态，尝试 E2N3 等非法房间；或用另一玩家尝试已经占用的 E3N3。仍被原规则拒绝，原 run/active/队列不变化，拒绝不更新其落地冷却。
4. **切回旧赛季**：在 E3N3 正常退出后，再落 W81 开放房间。新赛季 run 有 `endedTick`、当前新队列为空；旧 run 递增并恢复活动状态。两套已存历史不删除。
5. **重启保持**：E3N3 开局后保存状态，完整重启服务，再读取；run、startedTick、队列、active 不变，仍持有 E3N3，不重复开局/初始化地图。
6. **上一赛季到期不干扰**：测试副本可把旧赛季档位/窗口缩短，正常从旧赛季退出并落 E3N3后，运行超过原旧局到期 tick。E3N3 的玩家不被旧计时踢出，不产生旧局后续成绩。不要为此改线上窗口或直接注入线上旧队列；重放/并发边界由自动测试验证。
7. **阶段边界**：赛季 2 达到档位/窗口后仍没有新成绩、页面或自动退出，这是本步预期；也不要求额外清理整个 E81 的建筑。

结束后还原测试配置与快照。不要以本步验收为由在线上重拍地图、全区清场或提前开放完整赛季 2。

## 自动测试

测试只使用独立临时配置与数据库，未访问线上存档或 API。

| 测试 | 结果 |
| --- | --- |
| 第 8 步生命周期专项 | 22/22 |
| 赛季 2 配置/加载、落地、Invader、地图、封墙、全图规则 | 20/20、25/25、17/17、28/28、13/13、49/49，共 152/152 |
| 旧赛季与公共比赛专项（仅旧 mod / 双 mod） | 各 99/99 |
| 默认完整回归 | 667/667 |
| 仅旧 mod 完整混跑 | 744/765，21 项既有失败 |
| 双 mod 完整混跑 | 918/939，21 项既有失败 |
| TypeScript、本轮运行代码与赛季 2 严格 ESLint、diff 空白检查 | 通过 |

完整混跑的 21 项失败与第 6、7 步基线同名同序，无新增失败，**不是整包全部通过**；对比见 [failure-comparison.log](/private/tmp/xxscreeps-season2-step8.d4uQg2/failure-comparison.log)。失败仍为原版测试与赛季全图开关/规则的既有冲突，没有修改无关规则或原版测试来消除基线。

首次专项中的 7 个失败为测试夹具问题：数据库 hash 的 null prototype 比较，以及独立 CLI 夹具未初始化 intent constraints。已修正夹具、真实执行落地并保存账号/分片数据后验证第二进程读取，没有改变原版处理器或测试时限。后续新增区块外退出和未接入计分的边界测试，最终专项 22/22。中间日志保留，不把首次失败当通过。

上面的只读检查命令已原样提取、仅将 USER_ID 替换为临时玩家 100，连续执行两次结果相同；旧 run 的 endedTick、空旧队列、新独立队列与活动身份均符合预期，见 [read-state.log](/private/tmp/xxscreeps-season2-step8.d4uQg2/read/read-state.log)。没有访问真实账号库。

日志目录：[step8.d4uQg2](/private/tmp/xxscreeps-season2-step8.d4uQg2)。

从仓库根目录：

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/eslint/bin/eslint.js \
  packages/xxscreeps/mods/speedrun/{race-core,race-lifecycle,race,processor}.ts \
  packages/xxscreeps/mods/speedrun-season2 --max-warnings 0
```

从测试配置目录：

```bash
xxscreeps test "season-2 lifecycle"
xxscreeps test "season-2 initial spawn"
xxscreeps test "race core"
xxscreeps test "race results"
xxscreeps test "race restarts"
xxscreeps test "race pages"
```

## 回滚

停服回退第 7 步整套代码，再完整重启所有服务；无需成绩迁移。新 run/队列/active 键可留作验收记录，旧版本不消费赛季 2 队列；不要删除历史成绩或重新拍图。

回滚不会恢复已被结束的活动计时，旧版也不认识 active 校验；不要手动恢复旧定时队列再继续让玩家跨赛季。需要精确还原验收前现场时，停服恢复完整测试快照（包含账号库、分片库与相关存储），不能只回退地图或单个 run。

## 用户确认

- [ ] 赛季 1 正常落地、计分和旧榜不变。
- [ ] 赛季 2 只在实际 E3N3 成功落地后开局，队列和活动身份正确。
- [ ] 双向切换结束旧时钟、保留历史；重启不重开局。
- [ ] 用户明确通过后，才开始第 9 步独立计分与存储。
