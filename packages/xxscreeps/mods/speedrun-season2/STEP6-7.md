# 第 6、7 步验收：claim 和 Ruin 全图控制

日期：2026-10-13。用户已确认第 5 步通过，并要求“claim 和 Ruin 的规则都改成全图生效，无需独立配置。两个一起改好”。本轮只合并这两项，**第 8 步独立比赛未开始，赛季 2 全区清场也尚未实现**。自动测试与基线回归已完成，等待用户验收。

## 最终规则

| 配置 | false（默认） | true |
| --- | --- | --- |
| `speedrun.claimController` | 全图 `Creep.claimController` 返回 `ERR_INVALID_TARGET`（-7），不记录 claim intent | 全图恢复原版 claim 校验与执行 |
| `speedrun.ruins` | 全图阻止新增 Ruin，建筑中的资源随新 Ruin 一起被丢弃 | 全图正常插入 Ruin，保留原版资源与 decay |

两赛季、其他区块和 highway 都读取同一个开关。仅启用旧 mod 也全图生效；赛季 2 依赖旧 mod，无须新的 provider、sandbox payload 或重复包装。

- 两个开关互不控制，也不控制 Invader、deposit 或 power bank。
- claim 开关只包装这个游戏 API；reserve、attack、upgradeController 不变，初始落地仍使用自己的 placeSpawn intent。true 不是跳过 GCL、距离、CLAIM 部件和目标归属校验。
- Ruin 开关覆盖建筑普通摧毁、战斗/decay 使用的销毁入口，以及 placeSpawn 交接和 unspawn 退出的插入入口。不会删除已有 Ruin，不改变其自然衰减，也不处理 creep tombstone。正常摧毁事件日志仍保留。
- 不改变原有玩家整体 respawn、赛季 1 额外清理、赛季 2 落地限制、地形、比赛计时或成绩键。

## 文件与修改原因

| 文件 | 原因 |
| --- | --- |
| [旧 game.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/game.ts) | 去掉 W81 限定，继续使用唯一的旧 claim payload；保留缺失/异常 payload 默认拒绝的行为 |
| [旧 processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/processor.ts) | 去掉 Ruin 插入的 W81 限定；Invader、落地与比赛的范围判断保留 |
| [旧 config.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/config.ts)、[旧 schema](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/config.schema.json) | 明确两个既有开关全图生效，键名及默认值不变 |
| [新 config.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.ts)、[新 schema](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.schema.json) | 删除赛季 2 的 claim/ruins 类型、默认值和 schema 字段，只保留四项独立配置 |
| [旧 scope-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/scope-test.ts) | 将原先“区块外不限制”断言更新为全图开关；补充真实 sandbox 及运行中 payload 刷新测试 |
| [新 global-rules-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/global-rules-test.ts) | 在 W3N3、E3N3、W12N1、W0N0 验证 claim、三种 Ruin 入口、持久化、既有 Ruin 和 tombstone |
| [新 test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts) | 导入专项、更新默认值、验证真实启动流程拒绝废弃配置项 |
| [README.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/README.md)、[TODO.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/TODO.md) | 更新最终方案和合并验收顺序 |
| [STEP1.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP1.md)、[STEP5.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP5.md) | 为历史配置示例添加升级提醒，记录第 5 步用户确认 |

旧 driver 无须修改，它本来就发送单一 `speedrunClaimControllerAllowed`。赛季 2 运行 provider 不新增、不修改。

## 部署和配置

1. 保存原配置及完整存档快照，按正常流程构建、部署。
2. **删除 `speedrunSeason2.claimController` 和 `speedrunSeason2.ruins`，不是改为 false。** schema 保留 `additionalProperties: false`，残留键会导致启动校验失败。
3. 只在已有 `speedrun` 节点下设置全图开关；不要重复声明 YAML 根节点：

```yaml
speedrun:
  claimController: false
  ruins: false
  # 保留其他已有设置

speedrunSeason2:
  invaders: false
  respawnCleanup: true
  raceBrackets: [20000, 40000]
  respawnAfter: 40000
```

4. **全部服务完整重启**，尤其 runner 和 processor。仅重启 backend 不够；已有 sandbox 要加载新的 API 包装与配置 payload。
5. 不需要初始化/补墙/恢复地图、不需要主动 respawn、不需要迁移成绩或清空数据。赛季 2 比赛尚未完成，仍只在测试副本验证。

从部署时使用的配置目录执行只读检查：

```bash
xxscreeps eval -e '(async () => {
  const {config}=await import("xxscreeps/config/index.js");
  return JSON.stringify({
    global:{claimController:config.speedrun.claimController,ruins:config.speedrun.ruins},
    season2:config.speedrunSeason2
  },null,2);
})()'
```

默认全图两项为 false；赛季 2 只出现 invaders、respawnCleanup、raceBrackets、respawnAfter 四项。更改配置后必须重启，不支持在线热更新。

## 自动测试

测试使用独立临时配置和数据库，不连接线上。

| 测试 | 结果 |
| --- | --- |
| 全图 claim/Ruin 专项（含真实 payload、缺失/异常字段、四个区域、三种 Ruin 入口） | 49/49 |
| 旧赛季及公共比赛专项（仅旧 mod / 双 mod） | 各 99/99，含真实 sandbox 两 tick 开关刷新 |
| 赛季 2 配置/加载、Invader、地图、封墙、落地 | 分别 20/20、17/17、28/28、13/13、25/25 |
| 默认完整回归 | 667/667 |
| 仅旧 mod 完整混跑 | 744/765，21 项既有失败 |
| 双 mod 完整混跑 | 896/917，21 项既有失败 |
| TypeScript、赛季 2 和本轮修改代码严格 ESLint、diff 空白检查 | 通过 |

完整混跑的 21 项失败与第 5 步基线同名同序，涉及原版测试与赛季默认禁止 claim/Ruin/Invader/资源生成的冲突，**不是整包全部通过**。未修改的旧 test.ts 保持同名 16 项既有 warning、零 error。

开发中首次完整双 mod 回归暴露了新专项调用全部 runtime receive 时污染宿主 Memory 的测试隔离问题。已改为只调用实际注册的 claim consumer，不执行无关 Memory/flag hook；真实 sandbox 仍由独立 VM 验证。未修改 Invader 运行代码、测试或框架来掩盖该问题，修正后全图专项及完整回归通过上述基线比较。

附加整包复跑曾出现两个既有地图 CLI 用例触及框架 10 秒时限，结果为 894/917（21 项基线失败加 2 项超时）；该次日志保留在 `dual/full-suite.repeat.log`。不改地图代码或测试时限，串行独立复核地图组为 28/28，再次整包为 896/917，恢复同名同序的 21 项基线失败。最终对比见 [failure-comparison.log](/private/tmp/xxscreeps-season2-step6-7.fqydon/failure-comparison.log)，不把中间超时记录隐去，也不保证重负载下这些 CLI 用例永不超时。

文档的只读配置检查命令已实际执行，返回两个全图 false 及赛季 2 四项独立配置，见 [config-read.log](/private/tmp/xxscreeps-season2-step6-7.fqydon/dual/config-read.log)。

开发环境从仓库根目录编译、静态检查：

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/eslint/bin/eslint.js \
  packages/xxscreeps/mods/speedrun-season2/{config,test,global-rules-test}.ts \
  packages/xxscreeps/mods/speedrun/{game,processor,config,scope-test}.ts \
  --max-warnings 0
```

游戏专项须在**测试副本配置目录**执行，启用 classic、speedrun 和 speedrun-season2：

```bash
xxscreeps test "global claim and ruin rules"
xxscreeps test "season-1 scope"
xxscreeps test "mods/speedrun-season2"
xxscreeps test "ruin suppression"
xxscreeps test "respawn cleanup"
xxscreeps test "season-2 initial spawn"
```

临时测试日志目录：[step6-7.fqydon](/private/tmp/xxscreeps-season2-step6-7.fqydon)。

## 手动验收

所有 true 对照、建筑摧毁和退出都在完整存档的测试副本做；不要为了证明 true 在线上 claim 新房间或摧毁有价值的建筑。

### claim

1. 默认 false 下，在旧区块、新区块、区块外分别准备自己的 CLAIM creep 和中立控制器；确认调用返回 -7，下一 tick 房间仍中立。
2. 控制台示例（替换 creep 名）：

```javascript
const c = Game.creeps.TestClaimer;
c ? c.claimController(c.room.controller) : "missing creep";
```

3. 在测试副本把 `speedrun.claimController` 改成 true 并完整重启。同样场景满足 GCL、部件、距离、归属条件时返回 0，下一 tick 控制器属于自己。条件不满足时返回原版错误码，不是强制成功。
4. false 下 reserve、attack、upgrade 的合法场景仍正常；正常初始落地仍通过既有校验，赛季 2 只有 E3N3 能落地。
5. 还原 false 和测试快照，避免 true 对照的新增房间影响下一轮。

### Ruin

1. 默认 false 下，在两赛季和区块外准备可摧毁的人造建筑，记录对象 ID 和资源。执行普通 destroy 或测试战斗，下一 tick 建筑消失、不新增对应 Ruin；原有 Ruin 仍存在并正常衰减。
2. 在测试副本设 `speedrun.ruins: true` 并完整重启，恢复同一快照重做；应正常出现对应 Ruin，容器等建筑的资源保留其中。
3. 在 false/true 两种设置下分别验证普通 respawn 退出；被退出移除的 owned 建筑分别不留/正常留下 Ruin。**本步骤不要求赛季 2 额外清空 81 房的人造建筑，那是第 10 步。**
4. 两种设置下让测试 creep 死亡，tombstone 都正常出现；不能用 creep tombstone 判断 Ruin 开关。
5. 结束后恢复原配置及测试快照；已经因 false 丢弃的建筑资源不会因改回 true 自动回来。

## 回滚

回退到第 5 步整套代码并完整重启，无地图或成绩迁移。赛季 2 两个已删除的键在旧版本是可选项，不必为了回滚重新添加；需要复原配置时使用备份。

回退后 claim/Ruin 重新只受旧区块的限制，区块外回到原版行为。已经成功 claim 的房间、已丢弃的新 Ruin 及资源不会自动恢复；若要还原验收现场，停服恢复本轮测试前的完整存档。

## 用户确认

- [ ] 配置删除与启动检查通过，两个全图开关符合要求。
- [ ] 默认禁止全图 claim、不生成新 Ruin；true 对照及不受影响的 API、tombstone 正常。
- [ ] 旧赛季落地、比赛、地图和 Invader 规则正常。
- [ ] 用户确认第 6、7 步通过后，才开始第 8 步。
