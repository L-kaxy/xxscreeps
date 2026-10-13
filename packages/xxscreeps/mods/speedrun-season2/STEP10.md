# 第 10 步验收：手动 respawn 全区清场

后续验收记录：用户确认“通过，剩下的一步到位全部完成，我一起验收”。第 10 步已通过；本文保留当时的单步交付范围，当前自动重开和榜单功能见 [STEP11-14.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP11-14.md)。

日期：2026-10-13。第 9 步已由用户确认通过。本步只接入手动退出及其清场恢复，**不实现第 11 步到期自动重开，不增加排行榜 API/页面**。按用户追加要求：中央九房的 Extractor 不包括在清理范围内。当时等待用户验收；现已通过，见上方后续记录。

同日按用户要求收窄公共修改：**新 mod 外仅保留 `classic/spawn/model.ts` 的 respawn 扩展入口**。`classic/spawn/backend.ts`、`engine/processor/room.ts`、`engine/processor/symbols.ts` 已恢复为本步之前的内容。下文描述当前单公共文件方案。

## 本步行为

- 实际 `/api/user/respawn` 和公共 `respawnPlayer` 共用扩展入口；根据当前活动赛季或 E3N3 归属识别新赛季。旧赛季 respawn 不建立新清场任务。
- 玩家保持全世界退出：按原 presence、controlled、调用方额外房间列表交还房间，释放本人控制器、移除本人对象并清旗帜。账号、代码、Memory、GCL、历史成绩不重置。
- `speedrunSeason2.respawnCleanup: true` 时额外覆盖已初始化的 E81，**不按 owner/presence 过滤**，休眠房间也被唤醒：
  - 清 Spawn、Extension、Road、Wall、Rampart、Link、Storage、Tower、Observer、Power Spawn、Lab、Terminal、Container、Nuker、Factory。
  - 清非中央房间的 Extractor；**保留 E4N4～E6N6 已建成 Extractor**，包括原版预置的九个。
  - 所有 ConstructionSite 均清，包括中央九房 Extractor 施工点；已有 Ruin 同样清掉。
  - 保留的中央 Extractor 若属于退出玩家，保留原 ID/位置并改为无主，避免原版 unspawn 删除它或保留本人 presence。其他 owner 不变。
- Source、Mineral、Controller、Keeper Lair、世界 Portal、Power Bank 等不属于人造建筑；不拍图、不封中央九房、不修改地形或开放状态。本人 Controller 保留对象，仅释放归属。
- 直接移除建筑及其存储，不调用普通 destroy，不产生清场 Ruin 或建筑资源掉落，`speedrun.ruins: true` 也一样。不额外清理整个区块的 Tombstone、已有掉落资源或其他玩家 Creep。
- 新赛季配置设为 false 时不执行额外全区清理，仍保持原版玩家全局退出、停止本局及退出完成前的落地门禁；原版退出是否生成 Ruin 继续服从全图开关。
- 请求先持久化 generation 和门禁，再停止本局、投内部 intent。main 只在请求后的 tick 读取所有目标的已保存当前 buffer，确认本人已退出且应清建筑不存在后标记 complete。不依赖房间内存修改、尚未生效的下一份 buffer、processor 返回值或引擎保存通知；不是“收到请求就当清场结束”。
- 未完成期间禁止所有新区块落地，以及退出玩家提前转去旧赛季；其他旧赛季玩家不受此门禁影响。原房间占用、单人落地、presence、冷却检查保留，未增加人数锁或排队。
- 重复 respawn 复用 generation；main 在 scratch 队列丢失或重启后续投。过期/完成 generation 的 intent 直接忽略，保护下一局建筑。完成后持久化保留上一份任务，下一次清场生成新 ID。

持久化数据在 **shard.data**，不是成绩表：

```text
speedrun-season2/cleanup                         最后一次任务及状态
```

状态为 preparing → pending → complete。清场期间本局的 due/racing 被停止，已采集成绩及旧赛季成绩不删除。解锁有至少一次跨 tick 的存档核验，不能要求点击 respawn 后马上成功落地。

不再建立/读取房间保存 ack hash；旧版已持久化任务仍可恢复，旧 ack 不参与解锁判断。下一次替换旧 generation 时顺便删除它的遗留 ack key，无需操作员迁移数据。

原版休眠房间 finalize 会把保存后的状态同步到两份 buffer；只要已过请求 tick 且当前存档确实全部清洁，就可以完成，不额外等每个房间的 ack。保持活跃的房间仅写下一份 buffer 时，当前存档仍有建筑便继续阻挡，内存里的清理结果不能提前放行。

## 文件及修改原因

| 文件 | 原因 |
| --- | --- |
| [respawn.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/respawn.ts) | 建筑分类、中央 Extractor 例外、持久化任务、重复请求、门禁、请求后 tick 的当前存档核验和断点恢复 |
| [respawn-processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/respawn-processor.ts) | generation 校验后的内部清场；先移除建筑，再原版全局退出，不注册引擎保存 hook |
| [cleanup-processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/cleanup-processor.ts) | 每个房间 task 批次只获取一次清场互斥，避免重复 intent 等待同一锁死锁，并保留各玩家身份 |
| [backend.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/backend.ts)、[processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/processor.ts) | 在 mod 内按原版载荷形状先校验后认证，保留坐标字符串 coercion；HTTP 和内部 placeSpawn 均检查门禁，原始路由仍执行全部原版校验 |
| [main.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/main.ts) | 计分前恢复已手动请求的清场，不因 duration 自动创建清场 |
| [classic/spawn/model.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/classic/spawn/model.ts) | **唯一保留的 mod 外修改**：给公共 respawn 增加可注册拦截入口；无扩展时仍投原版 unspawn，不改旧赛季额外建筑清理 |
| [respawn-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/respawn-test.ts)、[test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts) | 实际路由、处理器、当前存档核验、并发、重复请求、重启恢复及旧赛季隔离测试；补充内存和下一份 buffer 不提前解锁的断言 |
| [xx.d.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/xx.d.ts) | 新增 internal intent 类型声明 |
| [config.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.ts)、[config.schema.json](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.schema.json)、[race.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/race.ts)、[index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts) | 更新实现阶段及 Extractor 例外说明；不增加配置字段或 provider |
| 同目录 README、TODO、STEP9、本文件 | 标记第 9 步验收通过，记录第 10 步范围、最新例外和验收操作 |

赛季 1 的范围、建筑清理、自动重开、成绩键名、页面不改。claim/Ruin、deposit/power bank 的全图开关及各自 Invader 区块开关不改。

撤回的三个公共文件已与本步之前的 HEAD 内容一致；不再增加引擎 API 或导出 classic 的私有载荷 schema。mod 内校验保持与原版四字段载荷一致，未来原版载荷变化时应同步维护；原始路由的最终校验不被替换。

## 部署和配置

1. **仅测试副本**，保留完整停服快照和配置，正常构建部署，完整重启所有服务。不在当前步骤对线上初始化或开放新赛季。
2. 不需要地图重拍、补墙、重新 import、迁移成绩或清空旧赛季队列；启动只恢复已有手动任务，不自行创建任务。
3. 确认已有 `speedrunSeason2.respawnCleanup: true`，默认即 true；旧 `speedrun.respawnCleanup` 继续独立。无需添加其他配置。
4. 先正常落 E3N3，再手动 respawn。到 `respawnAfter` 不自动退出是本阶段预期，留到第 11 步。

本轮开始时上一版修改已在 Git 暂存区；此次只更新工作区，未修改你的暂存内容或创建提交。提交前重新暂存本轮改动（包括三个公共文件的恢复），避免仍提交上一版四公共文件方案。当前工作区相对 HEAD 的 mod 外改动仅为 `classic/spawn/model.ts`。

## 手动验收

在服务端配置和测试数据目录运行 CLI，不是在玩家 Game 控制台执行。先备份本轮**完整测试存档**；将两段脚本的 USER_ID 改为同一实际账号 ID，需要其他 shard 时修改 `config.shards[0].name`。

### A. 清场前记录与只读检查（清场后重复）

以下检查不投 intent、不改建筑、地图或成绩。活服读取可能跨 tick，结果不稳定时暂停 tick 再读，或者重跑；不要凭清场过程中某一次快照判定通过。

```bash
xxscreeps eval --stdin <<'JS'
(async () => {
  const {createHash}=await import("node:crypto");
  const {config}=await import("xxscreeps/config/index.js");
  const {Database,Shard}=await import("xxscreeps/engine/db/index.js");
  const cleanup=await import("xxscreeps/mods/speedrun-season2/respawn.js");
  const {isSeason2Room}=await import("xxscreeps/mods/speedrun-season2/rooms.js");
  await using db=await Database.connect();
  await using shard=await Shard.connect(db,config.shards[0].name);
  const user="USER_ID", world=await shard.loadWorld();
  const job=await cleanup.readCleanup(shard);
  const rooms=[];
  for(const name of [...world.terrain.keys()].filter(isSeason2Room).sort()) {
    const room=await shard.loadRoom(name);
    const objects=room["#objects"];
    rooms.push({
      room:name,owner:room["#user"],
      artificial:objects.filter(cleanup.isCleanupObject).map(o=>o.id),
      extractors:objects.filter(cleanup.isPreservedExtractor).map(o=>({id:o.id,owner:o["#user"]})),
      mine:objects.filter(o=>o["#user"]===user).map(o=>o.id),
      objects:objects.map(o=>({id:o.id,type:o.constructor.name})),
    });
  }
  const old=await shard.loadRoom("W2N2");
  return JSON.stringify({
    time:shard.time,job,
    terrainHash:createHash("sha256").update(world.terrainBlob).digest("hex"),
    run:await db.data.hGetAll(`speedrun-season2/run/${user}`),
    active:await db.data.get(`speedrun/active/${user}`),
    oldObjects:old["#objects"].map(o=>({id:o.id,type:o.constructor.name})),rooms,
  },null,2);
})()
JS
```

记录 terrainHash、Source/Mineral/Controller/Keeper Lair ID、中央九房 Extractor ID、旧区块建筑 ID、当前 run 和已有成绩。旧区块自身正常运行可能改变 Creep 等临时对象，只比较要验证的旧建筑，或暂停 tick 比较。

### B. 可选停服造多房间清理夹具

正常落 E3N3 后**停止全部测试服务**。此命令主动写两份 room buffer，只可用于可恢复的测试副本。夹具在 E2N2 放无主 Road/Container，E9N9 放施工点和非中央 Extractor，帮助覆盖无 presence 房间；不改地形、自然对象、中央 Extractor 或旧区块。

```bash
xxscreeps eval --stdin <<'JS'
(async () => {
  const {config}=await import("xxscreeps/config/index.js");
  const {Database,Shard}=await import("xxscreeps/engine/db/index.js");
  const {Mutex}=await import("xxscreeps/engine/db/mutex.js");
  await import("xxscreeps:mods/game");
  const {initializeGameEnvironment,runOneShot}=await import("xxscreeps/game/index.js");
  const {RoomPosition}=await import("xxscreeps/game/position.js");
  const {flushUsers}=await import("xxscreeps/game/room/room.js");
  const {updateUserRoomRelationships}=await import("xxscreeps/engine/processor/model.js");
  const {create:road}=await import("xxscreeps/mods/classic/road/road.js");
  const {create:container}=await import("xxscreeps/mods/classic/resource/container.js");
  const {create:site}=await import("xxscreeps/mods/classic/construction/construction-site.js");
  const {create:extractor}=await import("xxscreeps/mods/classic/mineral/extractor.js");
  const C=await import("xxscreeps:mods/constants");
  initializeGameEnvironment();
  await using db=await Database.connect();
  await using shard=await Shard.connect(db,config.shards[0].name);
  await using mutex=await Mutex.connect("game",shard.data,shard.pubsub);
  await using lock=await mutex.acquire();
  if(await shard.data.get("mutex/main")!==null) throw Error("stop every service first");
  const user="USER_ID";
  if((await shard.loadRoom("E3N3"))["#user"]!==user) throw Error("land E3N3 first");
  const world=await shard.loadWorld(), created=[];
  for(const name of ["E2N2","E9N9"]) {
    const room=await shard.loadRoom(name), positions=[];
    const terrain=world.map.getRoomTerrain(name);
    for(let y=1;y<49&&positions.length<2;++y) for(let x=1;x<49&&positions.length<2;++x) {
      if(terrain.get(x,y)!==C.TERRAIN_MASK_WALL &&
         !room["#objects"].some(o=>o.pos.x===x&&o.pos.y===y)) positions.push(new RoomPosition(x,y,name));
    }
    if(positions.length!==2) throw Error("no fixture tiles");
    runOneShot(world,room,shard.time,user,()=>{
      const objects=name==="E2N2"
        ? [road(positions[0]),container(positions[1])]
        : [site(positions[0],C.STRUCTURE_EXTENSION,user,200),extractor(positions[1],null)];
      for(const object of objects) {
        room["#insertObject"](object);
        created.push({room:name,id:object.id,type:object.constructor.name});
      }
    });
    room["#flushObjects"](null);
    const previous=flushUsers(room);
    await shard.saveRoom(name,shard.time,room);
    await shard.copyRoomFromPreviousTick(name,shard.time+1);
    await updateUserRoomRelationships(shard,room,previous);
  }
  await shard.save();await db.save();
  return JSON.stringify(created);
})()
JS
```

这不是玩家正常 build 校验，非中央 Extractor 仅作为清理夹具。记录输出 ID 后重启全部服务，重新执行 A 并确认夹具存在。已有自然位置不改。

### C. 按客户端操作验收

1. E3N3 正常落地、造几种本人建筑。保留中央九房 Extractor 的检查记录；已有新旧历史成绩也记录下来。
2. 点手动 respawn，立即尝试 E3N3 落地，清场未结束时应拒绝；同一退出账号尝试旧赛季也应被门禁拒绝。不要通过改数据库移除门禁。
3. 等若干 tick，执行 A：任务应为 complete，E81 的 artificial/mine 均为空，本人控制器已释放；无主和多房夹具已消失，没有清场 Ruin。
4. 中央九房 Extractor ID 与清场前一致；非中央 Extractor、所有施工点消失。自然对象 ID、terrainHash 保持，中央九房仍开放且运行；旧区块无关建筑和历史成绩不被新清场修改。
5. 再正常落 E3N3，原版冷却若仍在生效则等待，不用把原版冷却报错当清场失败。成功后 run 加一、新局正常造建筑。
6. 重复手动 respawn：未完成时仍是同一 generation，完成后的下一次是新 generation；新局建筑不能被上一份延迟 intent 删除。
7. 在清场请求后、complete 前完整停服再启动，任务应继续并最终完成，不重拍地形。无需手工清 scratch；跨进程丢队列恢复由自动测试覆盖。
8. 用旧赛季账号做正常落地、记分及 respawn 回归：无新清场 generation，原旧建筑清理规则正常；其他旧玩家不会因新区块清场被整体锁住。

为了覆盖 Ruin 开启，只在测试副本临时设 `speedrun.ruins: true`、完整重启后重测，再还原。本人建筑未额外全区清理时，原版退出生成 Ruin 属于 false 开关对照的预期。

## 回滚

- 停止全部服务，回滚本步代码，恢复配置；未发生清场可不改地图或成绩。
- **清场已经移除的建筑无法靠回滚代码恢复**，需要恢复本轮开始前的完整测试存档快照，包括 room、shard/database 持久化数据及配置。不要只还原地形。
- 不可在未完成状态删除 cleanup 数据、手工标 complete、清队列然后强行开新局。需要停止服务整体恢复快照，否则迟到任务和存档状态可能不一致。

## 自动测试

### 当前单公共文件方案（2026-10-13 复测）

| 环境 / 检查 | 实际结果 |
| --- | --- |
| 双 mod 清场专项 | 19/19 |
| 双 mod 原有落地专项 | 25/25 |
| 默认完整回归 | 681/681 |
| 仅旧 mod 完整回归 | 762/783，21 项既有失败 |
| 双 mod 完整回归 | 982/1003，21 项既有失败；全部 220 项赛季 2 专项通过 |
| TypeScript、相关严格 ESLint、diff 空白检查 | 通过 |
| 文档夹具与只读命令 | 独立临时数据库实测通过，81 房清洁、九个原版 Extractor 和自然 ID 保留，地形、旧房间及当前 run 局数不变 |
| 公共修改范围 | `git diff HEAD` 确认 mod 外仅 `classic/spawn/model.ts`；其余三个公共文件内容与 HEAD 一致 |

仅旧 mod 和双 mod 的失败名称、顺序均与首次交付及地形修复后基线一致，**无新增失败，不把整包混跑标为全通过**。没有访问线上存档/API，没有增加时限或取消旧赛季、落地检查。

清场专项原有 17 项保留，存档确认测试改为实际当前 buffer 核验；新增两项分别验证：请求后 tick 的内存清理/未生效下一份 buffer 不提前解锁，以及持久化脏房在丢队列后继续阻挡并恢复清理。休眠房间同步双 buffer 的情况也检查实际当前存档，而不是假设每次 finalize 都只写下一份 buffer。

本次收窄日志：

- [清场 19 项](/private/tmp/xs2-step10-onefile.v8j3v4xx/cleanup-final.log)、[落地 25 项](/private/tmp/xs2-step10-onefile.v8j3v4xx/spawn-final.log)。
- [默认完整](/private/tmp/xs2-step10-onefile.v8j3v4xx/default/full-suite.log)、[仅旧赛季完整](/private/tmp/xs2-step10-onefile.v8j3v4xx/old/full-suite.log)、[双赛季完整](/private/tmp/xs2-step10-onefile.v8j3v4xx/dual/full-suite.log)。
- [文档夹具清场前](/private/tmp/xs2-step10-onefile.v8j3v4xx/doc-with-fixture.json)、[清场后](/private/tmp/xs2-step10-onefile.v8j3v4xx/doc-after.json)。

### 首次方案记录

首次四公共文件方案的结果（历史记录；单公共文件方案复测结果另列）：

| 环境 / 检查 | 实际结果 |
| --- | --- |
| 双 mod 清场专项 | 17/17 |
| 双 mod 原有落地专项 | 25/25 |
| 默认完整回归 | 681/681 |
| 仅旧 mod 完整回归 | 762/783，21 项既有失败 |
| 双 mod 完整回归 | 980/1001，21 项既有失败；全部 218 项赛季 2 专项通过 |
| TypeScript、相关严格 ESLint、diff 空白检查 | 通过 |
| 文档停服夹具、只读命令与清场后存档对照 | 在独立临时数据库实测通过，81 房清洁、九个原版 Extractor 和自然 ID 保留，地形及旧房间不变 |

两个赛季环境的失败名称及顺序均与地形修复后的基线完全一致，涉及原版测试与已启用 claim、Ruin、Invader、资源规则的既有冲突。无新增失败，**不能记录为整包混跑全部通过**。没有访问线上存档或 API。

中间迭代修正了未来 room buffer 不可读取、重复任务获取同一互斥及两项落地兼容问题（认证前载荷校验、异步 handover 插入对象的刷新）。未降低原有断言、延长时限或修改原版认证/玩法规则；最终完整复跑只有上述基线失败。

本轮日志：

- [清场专项最终复测](/private/tmp/xs2-step10.Ww9S8j/cleanup-final.log)、[落地专项复核](/private/tmp/xs2-step10.Ww9S8j/spawn-recheck.log)。
- [默认完整复核](/private/tmp/xs2-step10.Ww9S8j/default/full-suite-recheck.log)、[旧赛季完整复核](/private/tmp/xs2-step10.Ww9S8j/old/full-suite-recheck.log)、[双赛季完整复核](/private/tmp/xs2-step10.Ww9S8j/dual/full-suite-recheck.log)。
- [地形修复后基线](/private/tmp/xxscreeps-terrain-dual-full-recheck.log)。
- [文档夹具清场前](/private/tmp/xs2-step10.Ww9S8j/doc-with-fixture.json)、[清场后](/private/tmp/xs2-step10.Ww9S8j/doc-after.json)。

临时日志供本轮追溯，可能被系统清理；结论及验收操作已记录在仓库内。

构建/lint 在仓库根目录运行；测试在各自独立配置及临时数据目录运行：

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/eslint/bin/eslint.js packages/xxscreeps/mods/speedrun-season2/*.ts packages/xxscreeps/mods/classic/spawn/model.ts --max-warnings 0
node --experimental-vm-modules /Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js test "season-2 respawn cleanup"
node --experimental-vm-modules /Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js test
```

交付后停在第 10 步，等待用户确认，不提前接第 11 步。
