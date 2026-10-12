# 第 5 步验收：Invader 按区块独立控制

日期：2026-10-13。用户确认第 4 步（含出口封墙）“通过 下一步”，授权本步开发。**本步已由用户确认通过，并授权合并第 6、7 步，将 claim 与 Ruin 改为全图控制。** 只在完整存档的测试副本验证，不在线上开放未完成的赛季 2。

## 范围和实现

| 房间范围 | 周期生成配置 |
| --- | --- |
| `W1N1～W9N9` | `speedrun.invaders`，保持旧实现 |
| `E1N1～E9N9` | `speedrunSeason2.invaders`，本步接入 |
| 两区块以外，包括 highway | 不读取上述两个开关，保留原版周期生成 |

- `false`：在原版生成器之前清零所属区块的 `#cumulativeEnergyHarvested`，首个处理 tick 也不会因旧预算漏出最后一波。
- `true`：不干预预算或生成器，继续原版阈值、随机目标、邻房 owner/reservation 过滤及出口选择。**启用不等于立即生成，也不保证没有可用出口时生成。**
- 不改 `#invaderEnergyTarget`。采集 intent 本身仍正常运行，在这一 tick 后面增加的预算，会在下一个房间处理 tick 再清零。
- 开关是按房间而不是按玩家控制，不回退读取另一个赛季的设置。更改 YAML 后需要完整重启服务，不是热更新。
- 不删除已有 Invader，不停止其 NPC 行为，不关闭 Source Keeper 或中央九房原生机制，不新增强盗核心/stronghold 控制。
- `/api/game/create-invader` 和内部 `requestInvader` 保持原版主动请求行为及校验，**不受周期生成开关限制**，与旧赛季一致。不要用主动请求成功/失败验证本开关。
- 没有地图重拍、数据迁移、清场、比赛或榜单逻辑；deposit/power bank 仍由 `speedrun` 两个全图开关控制。

## 文件及原因

- [processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/processor.ts)：在原版 room tick 队列前增加新区块预算控制；与旧赛季 hook 的范围不相交。
- [invader-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/invader-test.ts)：真实 RoomProcessor、原版异步生成器、存档缓冲、NPC、采集及主动请求 API 测试。
- [map-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/map-test.ts)：完整混跑再次暴露真实 CLI 重复初始化/恢复合并用例的累计启动超时，将两个行为拆成独立用例，每项仅启动夹具和一个待验收命令；原有实际 CLI 断言保留，不增加框架时限、不跳过集成测试。
- [test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts)：加载新专项；provider 骨架检查更新到第 5 步。
- [index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts)：仅更新阶段说明，不增加 provider。
- [config.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.ts)、[config.schema.json](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.schema.json)：明确已接入的开关及边界；键、类型、默认值不变，默认 `false`。
- [旧赛季 test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/test.ts)：仅给“启用入侵且有旧预算”的测试增加真实 `say` intent，确保即使尝试移动被地形挡住，原版异步生成结果仍有更新信号被保存；不把测试持久化依赖误判为新开关压制旧区块。原移动操作、实际生成和存档后断言保留，没有修改旧运行代码。
- README、TODO、第 4 步文档及本文：记录前一步验收和本步操作。

没有修改旧赛季运行代码、原版 Invader 生成器、NPC 引擎或全图资源控制。

## 自动测试

在启用两个 mod 的独立测试配置目录运行：

```bash
node --experimental-vm-modules \
  /Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js \
  test "season-2 invaders"
```

本专项使用独立测试存档，CLI 集成及本地存储需要 IPC socket 权限；不能把 `0 tests` 算作通过。

覆盖：两个开关四种组合的预算和实际生成；全部 81 房与区块外；旧预算、持久化及重新启用；采集前后顺序；已有 Invader 战斗；中央九房全部 32 个原生 lair 生成 Keeper；owner/reservation 邻房过滤、单出口和无出口；真实主动请求 API 和 intent；地图、历史成绩及未接入的赛季 2 队列不变。

最终串行专项：

| 专项 | 实际结果 |
| --- | --- |
| Invader 独立控制 | 17/17，重复复测也全部通过 |
| 赛季 2 地图 | 28/28 |
| 赛季 2 封墙、落地、配置/加载 | 13/13、25/25、20/20 |
| 仅旧 mod 下旧赛季及公共比赛 | 95/95 |
| 双 mod 下旧赛季及公共比赛 | 95/95 |

原旧赛季入侵组三项在仅旧 mod、双 mod 下各连续执行四遍，合计 24/24。地图从 27 项变为 28 项是拆分真实 CLI 重复初始化/恢复用例，不是新增地图运行功能。新专项保留原版随机目标的行为，包括可能出现零增量，不修改原生成器。

最终完整回归：默认配置 **667/667**；仅旧 mod **740/761**；双 mod **843/864**。后两者的 **21 项既有失败名称及顺序**与第 4 步已验收基线完全一致，**没有新增失败，但完整混跑不是全部通过**。首次混跑的旧入侵测试持久化不稳定和再次复测的 CLI 合并用例超时，分别以真实玩家更新 intent、拆分测试修正；没有修改旧运行规则或框架时限。

TypeScript 构建及赛季 2 严格 ESLint 通过；旧测试文件零 error，原有 16 项 warning 的规则与消息完全不变，没有新增诊断。本文只读检查及高预算夹具的代码已在独立临时存档跨进程实际执行，两个房间读回 `300000/0`；没有操作线上存档，也没有运行线上 NPC 请求。

测试日志与失败名对照：`/private/tmp/xxscreeps-season2-step5.LZoRKP`。

## 部署与配置

1. 使用第 3～4 步已验收的测试副本，保留完整存档备份。
2. 正常部署、构建新代码；继续启用原有两个 mod：

   ```yaml
   mods:
     - xxscreeps/mods/speedrun
     - xxscreeps/mods/speedrun-season2
   ```

   保留其他 mod、旧赛季配置和已验收的地形；不执行初始化、补墙或恢复命令。

3. 两个根节点分别设置开关，**合并进现有节点，不要用此片段覆盖其他配置**：

   ```yaml
   speedrun:
     invaders: false
   speedrunSeason2:
     invaders: false
   ```

4. 完整重启全部服务，特别是所有 processor worker。遗漏新区块开关时仍用自己的默认 `false`，不是旧配置值。
5. 先运行上述专项（应执行非零测试数且全部通过），再做现场检查。

## 手动验收

### A. 配置读取与四种组合

在测试服务使用的配置目录读取，不连接游戏数据库：

```bash
xxscreeps eval -e 'import("xxscreeps/config/index.js").then(({config}) => JSON.stringify({season1:config.speedrun?.invaders,season2:config.speedrunSeason2?.invaders}))'
```

逐项修改两个开关，每次完整重启，核对读取值：

| `speedrun.invaders` | `speedrunSeason2.invaders` | 旧区块周期生成 | 新区块周期生成 |
| --- | --- | --- | --- |
| false | false | 禁用 | 禁用 |
| false | true | 禁用 | 原版 |
| true | false | 原版 | 禁用 |
| true | true | 原版 | 原版 |

区块外预算/生成不跟随这两项变化；旧赛季比赛、地形、建筑和历史成绩仍正常。本步不产生赛季 2 成绩。

### B. 预算与已有 NPC 的现场检查

在原测试配置及数据目录执行以下**只读**检查；默认使用配置的第一个 shard，需要检查其他目标时将 `config.shards[0].name` 替换为其实际 name：

```bash
xxscreeps eval --stdin <<'JS'
(async () => {
  const {config}=await import("xxscreeps/config/index.js");
  const {Database,Shard}=await import("xxscreeps/engine/db/index.js");
  const {Creep}=await import("xxscreeps/mods/classic/creep/creep.js");
  await using db=await Database.connect();
  await using shard=await Shard.connect(db,config.shards[0].name);
  const world=await shard.loadWorld();
  const result=[];
  for(const name of ["W7N7","E3N7"]) {
    const room=await shard.loadRoom(name);
    result.push({
      room:name,harvested:room["#cumulativeEnergyHarvested"],target:room["#invaderEnergyTarget"],
      exits:world.map.describeExits(name),
      invaders:room["#objects"].filter(o=>o instanceof Creep&&o["#user"]==="2").map(o=>o.id),
      keepers:room["#objects"].filter(o=>o instanceof Creep&&o["#user"]==="3").map(o=>o.id)
    });
  }
  return JSON.stringify(result,null,2);
})()
JS
```

- 在 `false` 对应区块，房间处理时清预算；若该 tick 有采集，读取到少量采集量正常，下一次处理前会清掉，不能要求任何时刻读数都恒为零。
- 在 `true` 对应区块，采集预算继续累计。原版生成条件为 `harvested - target > (target || 100000)`；不是只要 harvested 超过 100000 就一定生成。
- 若已有 Invader，切为 false 后不会立刻消失，应继续移动/战斗并按原寿命消失。中央九房 Keeper 继续存在/再生。
- 普通房间须有实际可用出口，且出口邻房不 owned/reserved，才会周期生成；全被占用或封墙时不出现 NPC 不代表开关失效。
- 修改场景后不要只靠“等了几 tick 没有 NPC”判定 false 正确；使用专项中的高预算正反对照，或按下面方式构造测试副本。

### C. 可选：停服构造高预算对照（仅测试副本）

如果不想等待自然采集，先保留**这轮测试前的完整停服快照**，停止全部服务，使用原测试数据目录执行下面的夹具代码。它仅将 `W7N7`、`E3N7` 两份 room buffer 的 budget/target 设为 `300000/0`，保留其他对象，但仍属于主动修改存档，**不得在线上使用**。

先确认两个目标房间都有可用出口、邻房不 owned/reserved，记录现有 Invader ID。建议选择有持续玩家采集/普通 intent 活动的房间，例如让观察 Creep 每 tick 执行 `say`；可将两段代码中的目标数组统一替换为旧赛季实际活动房间及 `E3N3`。不在本步骤额外修改原版生成器的休眠/持久化行为。修改目标配置组合后，每轮从同一停服快照开始，以免上一轮 Invader、预算或目标影响下一轮。

```bash
xxscreeps eval --stdin <<'JS'
(async () => {
  const {config}=await import("xxscreeps/config/index.js");
  const {Database,Shard}=await import("xxscreeps/engine/db/index.js");
  const RoomSchema=await import("xxscreeps/engine/db/room.js");
  await using db=await Database.connect();
  await using shard=await Shard.connect(db,config.shards[0].name);
  if(await shard.data.get("mutex/main")!==null) throw Error("Stop all services and wait for the main lock to expire");
  const buffers=[];
  for(const name of ["W7N7","E3N7"]) {
    for(const slot of [0,1]) {
      const key=`room${slot}/${name}`;
      const room=RoomSchema.read(await RoomSchema.upgrade(db,await shard.data.req(key,{blob:true})));
      room["#cumulativeEnergyHarvested"]=300000;
      room["#invaderEnergyTarget"]=0;
      buffers.push([key,RoomSchema.write(room)]);
    }
  }
  for(const [key,blob] of buffers) await shard.data.set(key,blob);
  await shard.save();
  return "Test-only room budgets prepared";
})()
JS
```

全部启动后，首个房间处理 tick 应清掉 false 区块的旧预算而不新增周期 Invader；true 区块满足原版出口条件时可生成一波。启动时正常会处理所有开放房间；现场持久化的对照使用上述持续玩家活动场景，不以无人活动房间的一次读取判定开关。重复只读检查 NPC ID 和预算；必要时用客户端观察，不用手动 `create-invader` 充当周期生成。

上述夹具不是受保护的地图命令，没有新增线上管理 API；主锁检查也不能替代“停全部服务”，不要从运行中的容器 `docker exec` 执行写入。单容器共享 `/data` 的部署可以在停服后使用同镜像 `docker run --rm --volumes-from <测试容器> -w /data ...`，分服务部署还须复用原网络及配置。

结束后恢复测试前的完整快照及原配置，或保留已确认的测试状态。不要拿 `season2-map --restore` 清理本场景，不删除赛季成绩表。

## 回滚

回到第 4 步（含补墙）的整套代码并完整重启，无数据迁移，不恢复或重拍地形。回退后新区块不再有独立周期生成限制，测试服应保持不开放。

开关 false 已丢弃的采集预算不会因重新启用或代码回退自动回来，原目标没有被本步改写；已有 Invader 也不会被清掉。若必须还原本轮人工预算夹具或完整现场，停服恢复测试前的完整快照。

## 用户确认

- [x] 用户确认第 5 步通过；本步专项和回归结果见上文。

用户确认：“通过，后面6和7步，claim 和 Ruin 的规则都改成全图生效，无需独立配置。两个一起改好。”
