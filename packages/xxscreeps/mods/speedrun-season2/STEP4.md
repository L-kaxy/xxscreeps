# 赛季 2 第 4 步 初始落地限制验收

日期：2026-10-13。实现和自动测试已完成，**等待用户验收；第 5 步尚未开始。**

本步只限制新区块初始落地。地图已在第 3 步初始化的测试副本中验收；**暂不在线上开放赛季 2**，独立 Invader/claim/Ruin、计时计分及清场仍未接入。

## 修改文件及原因

| 文件 | 原因 |
| --- | --- |
| [rooms.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/rooms.ts) | 增加 API 和 processor 共用的 `allowsInitialSpawn`；仅新区块受限制，固定允许 `E3N3` |
| [backend.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/backend.ts) | 包装已有 `/api/game/place-spawn` POST 路由；非法房间在入队和写冷却前返回错误，不注册第二条竞争路由 |
| [processor.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/processor.ts) | 包装已有 `placeSpawn` handover，阻止绕过 HTTP 的内部 intent 落到其他 80 房；拒绝时不调用旧计时链 |
| [index.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/index.ts) | 增加 `backend`、`processor` provider；旧赛季依赖保证原版及旧 mod 先加载 |
| [spawn-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/spawn-test.ts)、[test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/test.ts) | 增加 25 项落地专项，更新配置/加载测试的 provider 预期 |
| [config.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.ts)、[config.schema.json](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/config.schema.json) | 仅更新开发进度注释/描述；没有增加配置项、改变默认值或前缀 |
| README、TODO、STEP3 及本文 | 记录第 3 步用户确认和第 4 步交付 |

**没有修改赛季 1 运行代码、原版 spawn 代码、地图或旧成绩存储。**

## 实现边界

- `E1N1～E9N9` 内仅允许 `E3N3`，其余 80 房全部拒绝，包括无 Controller 的中央九房。
- API 返回：

  ```json
  {"error":"Season 2 initial spawn is only allowed in E3N3"}
  ```

  拒绝不写 `lastSpawnTime`、不发 intent、不启动或结束比赛，不删除建筑。
- 实际 processor 也检查同一个房间规则；内部 intent 不能绕过限制。非内部玩家 payload 仍不能调用原版内部 handover。
- 合法房间继续执行原版 API 的 schema、坐标、地形/建筑位置、占用、reservation、全局 presence 和 respawn 冷却检查；processor 保留原版无主房间 handover。没有重写或额外增强这些检查。
- 房间已经占用时不能让第二人落地。两个请求在同一 tick、房间仍为空时，允许原版方式入队，processor 只完成一次接管；不新增全局单人锁、排队、实例或预约。
- 区块外全部走已有规则，包括赛季 1、其他 sector 和 highway；没有扩大新区块限制。
- `E3N3` 落地**不启动赛季 2 比赛**，不产生新成绩或排行榜。旧赛季原本就会在成功落到区块外时停止旧时钟，此行为保留；拒绝的落地不会停止它。
- 本步不改变 respawn、claim、Invader、Ruin、deposit 或 power bank。特别是，赛季 2 全区建筑清场尚未实现。

## 自动测试实际结果

| 检查 | 结果 |
| --- | --- |
| TypeScript `tsc -b`；赛季 2 严格 ESLint | 通过 |
| 初始落地专项 | 25/25 |
| 配置及加载专项 | 20/20 |
| 地图专项，含实际 CLI 持久化 | 26/26 |
| 旧赛季八组专项，仅旧 mod / 双 mod | 各 80/80 |
| 公共比赛专项，仅旧 mod / 双 mod | 各 15/15 |
| 默认完整测试 | 667/667 |

整包混跑：仅旧 mod **739/761**，双 mod **810/832**。均保留第 3 步的同名、同顺序 **22 项既有失败**，没有新增失败；不将混跑记录为全部通过。

专项遍历全部 80 个禁止房间，并验证真实注册 API 路由的原始校验器、真实 intent 入队及 RoomProcessor 接管；覆盖冷却、全世界 presence、占用/预定、非法 tile、原版数字字符串转换、认证/schema 顺序、并发入队、旧比赛和旧数据保护。直接路由测试为 owner/reservation getter 临时提供测试账号的 Game user-info cache，执行后恢复；没有访问线上 API 或存档。

日志目录：`/private/tmp/xxscreeps-season2-step4.kJmhw3`，完整失败基线对照在该目录 `failure-comparison.log`。

本地编译及检查：

```bash
cd /Users/jason/workspace/nodejs/xxscreeps
./node_modules/.bin/tsc -b
./node_modules/.bin/eslint --max-warnings 0 packages/xxscreeps/mods/speedrun-season2
```

在启用双 mod 的独立测试目录执行：

```bash
bin=/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js
node --experimental-vm-modules "$bin" test "season-2 initial spawn"
node --experimental-vm-modules "$bin" test "mods/speedrun-season2"
node --experimental-vm-modules "$bin" test "season-2 map"
node --experimental-vm-modules "$bin" test "race core"
```

预期分别为 25、20、26、15 项全部通过，不能是 `0 tests`。地图 CLI 集成测试需要允许临时 IPC socket；同一配置目录不要并发测试进程。

## 部署与手动验收

### 1 正常部署，无数据迁移

- 使用第 3 步的完整存档测试副本，保留备份；本步会真实落地，不要把它当成只读地图检查。
- 正常构建并更新代码，完整重启 backend、processor 等服务，使新增 provider 生效。
- 保留两个 mod 和原配置；没有新配置、迁移或手工数据库操作。
- **不要重跑地图初始化，不执行整图 import。** 若还没有新区块，先按 [STEP3.md](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/STEP3.md) 在停服测试副本初始化。
- 仅部署到旧赛季线上且未初始化新区块时，没有额外操作；仍不要在线上拍图或开放新赛季。

### 2 非法落地，随后合法落地

用没有任何游戏对象的测试账号 A，确认原版 respawn 冷却已过。客户端在 `E2N3` 选择初始 Spawn，应被拒绝；也可测试 `E9N9`、`E5N5`。

若用 API，使用测试客户端现有请求中的 `X-Token`，不要把 token 发到聊天中。在该测试服务的浏览器开发者工具执行：

```javascript
const testToken = "<测试账号A的现有X-Token>";
async function trySpawn(room, x, y) {
  const response = await fetch("/api/game/place-spawn", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Token": testToken },
    body: JSON.stringify({ room, x, y, name: "Spawn1" })
  });
  return response.json();
}
await trySpawn("E2N3", 25, 25);
```

预期错误文本与上方一致，目标没有 Spawn、Controller 没被占用，没有新比赛或冷却消耗。测试账号 A 随后可尝试 `E3N3`：

```javascript
await trySpawn("E3N3", 2, 2);
```

`(2,2)` 已对固定初始地图核对为无对象可走地形；若测试现场已有对象，改用客户端选取其他合法空地。

预期 API `{ok:1}`，随后正常 tick 中 `E3N3` 变为账号 A 的 RCL 1，所选坐标出现唯一 Spawn。**本步没有赛季 2 比赛数据；旧排行榜不会新增 E3N3 记录。**

### 3 原版校验仍有效

每个用例使用干净的测试副本/账号，或恢复测试快照；不要依赖尚未实现的赛季 2 全区清场来复位：

1. 账号 A 已落地后，用无 presence 的账号 B 尝试 `E3N3`：拒绝，不出现第二个 Spawn。
2. 一个在旧赛季或其他房间已有对象的账号尝试空的 `E3N3`：仍被原版 presence 检查拒绝。
3. 空房间使用 `(-1,25)`、`(50,25)`、边界或墙格：拒绝，不产生 Spawn。
4. 原版冷却未过的账号尝试空 `E3N3`：仍被拒绝。不要为了测试改线上冷却或删除数据库键。
5. 干净账号在旧赛季合法房间落地：旧比赛照常开始，旧计分、历史和排行榜保持正常；可以沿用前一步的旧赛季验收方法。
6. 重启测试服务后规则仍生效，地图不重拍；旧区块建筑和既有成绩保留。

## 回滚

- 本步没有数据迁移，回退到第 3 步代码并完整重启即可移除这条新限制；地图不会自动删除。
- 若新区块仍保留，回退后不再有 E3N3 限制，必须避免玩家使用这个测试环境。
- 本步已经落地时，地图初始化回滚会因玩家活动而保护性拒绝。需要重置测试现场时恢复完整停服快照，不绕过保护，不手工删日志。
- 暂不验证赛季 2 成绩、独立 Invader、claim、Ruin 或全区清场；这些属于后续步骤。

## 用户确认

- [ ] 新区块非法房间拒绝，且不消耗落地冷却。
- [ ] `E3N3` 合法空地可以落地，原版占用/presence/位置/冷却检查仍有效。
- [ ] 旧赛季落地及比赛正常；新区块尚不产生比赛数据。
- [ ] 用户确认第 4 步通过，才开始第 5 步 Invader 独立控制。
