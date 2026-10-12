# 第 4 步补充：朝封闭 highway 的出口封墙

日期：2026-10-13。用户已确认落地正常，并追加本要求；实现和专项测试完成。用户随后确认“通过 下一步”，**本项验收通过，授权进入第 5 步。**

## 范围

仅封新区块普通房间朝封闭过道的一面，不封整个房间，也不改 highway 本身：

| 普通房间 | 相邻封闭 highway | 普通房间被封的边 |
| --- | --- | --- |
| `E1N1～E1N9` | `E0N1～E0N9` | 左边，`x=0` |
| `E9N1～E9N9` | `E10N1～E10N9` | 右边，`x=49` |
| `E1N9～E9N9` | `E1N10～E9N10` | 上边，`y=0` |
| `E1N1～E9N1` | `E1N0～E9N0` | 下边，`y=49` |

每面完整 50 格（含角落）设为 `TERRAIN_MASK_WALL`，不是玩家建造的 wall 建筑。四条 highway 都关闭时涉及 **32 个普通房间、36 面**；四个角房各封两面。同步更新 `exits`，`Game.map.describeExits` 不再显示这些朝外方向。

- 中央九房、内部连接、房内其余地形不变；不镜像、不随机生成、不修内部出口。
- 源 JSON 保持原版不变；只在实际初始化写入之前施加这层边界处理。
- 不开关 highway，不改 highway 地形、旧赛季或其他区块。如果某个 highway 实际处于开放集合中，跳过面向它的边；不存在的外侧房间按不可通行处理。
- 只补墙，不自动重新开放以前封过的边；以后需要开放过道时另行讨论恢复方案。
- 不修改任何房间缓冲、Controller、Spawn、建筑、Creep、NPC、tick、落地冷却或成绩。**已落地的测试现场也可补墙。**
- 仅阻止继续走上出口格，不搬迁已经站在边界格的对象，不新增跨区 intent/portal 拦截。

## 修改文件及原因

- [highways.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/highways.ts)：区块外围方向映射、closed highway 判断、复制后封边及 exit 重算。预览不修改原地形 buffer。
- [map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/map.ts)：新初始化包含封边；另提供已有地图的只读预览和停服地形补丁，第一次写入前保留 terrain 备份。
- [season2-map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/scripts/season2-map.ts)：新增 `--seal-highways` 动作，可配合 `--dry-run`；写入沿用主锁、game mutex、本地存储宿主和停服确认保护。
- [map-test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/map-test.ts)：新增封边专项，包含真实 CLI 持久化和实际移动正反对照。
- [旧赛季 test.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun/test.ts)：修正已有恢复测试的 byte-for-byte 断言，改为比较全部解码字段的零填充序列化结果，避免将 allocator padding 误判为地图变化；没有改旧赛季改图或恢复运行代码。
- 方案、TODO、资源及步骤文档：记录这项追加要求，替代原先“不处理边界”的约定。

没有改赛季 1 运行代码、落地实现或 provider，没有新配置项。

## 已有地图的操作

**不要重新 `--initialize`，不要重新 import 或重拍地图。重复初始化仍是 no-op，不会替已初始化的地图补墙。**

正常部署新代码后，在第 3～4 步测试副本中操作：

1. 保留完整停服存档快照，停止全部服务（不是 pause，不从运行服务中 `docker exec` 写地图）。
2. 同一配置及数据目录预览：

   ```bash
   xxscreeps season2-map --seal-highways --dry-run
   ```

   `written:false`，四条过道关闭时 `rooms:32, edges:36`；`faces` 列明对应面，`changedRooms` 是实际还需要改的房间。该命令不写游戏数据。

3. 确认后补墙：

   ```bash
   xxscreeps season2-map --seal-highways --server-stopped
   ```

   首次需要修改时 `state:sealed, written:true`。仍然使用原数据目录和目标 shard；需要时添加 `--shard name`。

4. 再预览应 `changedRooms:[]`；重复补墙为 `written:false`，不会覆盖首次备份。
5. 完整启动服务，让 backend、processor、runner 的 terrain/pathfinder 缓存统一重新加载。

默认单容器、本地数据与配置放在共享 `/data` 的 Docker 测试部署示例：

```bash
image=$(docker inspect -f '{{.Image}}' xxscreeps-test)
docker stop xxscreeps-test
docker run --rm --volumes-from xxscreeps-test -w /data "$image" \
  season2-map --seal-highways --dry-run
docker run --rm --volumes-from xxscreeps-test -w /data "$image" \
  season2-map --seal-highways --server-stopped
docker start xxscreeps-test
```

先部署本补充版本，容器名按实际替换；分服务或 Redis 环境须停全部服务、复用原网络及配置。主锁未释放就等待，不手工删锁。

新测试地图直接执行正常初始化即可自动封边；不需额外补墙。没有自动启动写图钩子。

## 备份、失败与回滚

首次真正补墙前，持久化整个当时 terrain：

```text
speedrun-season2/mapBackup/beforeHighwaySealing
```

不覆盖原初始化的备份或日志。此备份只是 terrain，不包含房间建筑和玩家数据，也不是“可以直接把旧整图写回”的回滚指令。

补墙是一次整个 terrain key 的替换，失败后保持停服，重新预览；需要时可幂等重试，不手工删初始化日志。备份保存失败时不会开始写新地形。

回退代码不会撤销已写入的墙。需要撤销时，在测试副本恢复补墙前的完整停服快照，再使用上一版本。不要执行 `season2-map --restore` 来撤销补墙：它是删除整个新区块的初始化回滚，已落地后还会保护性拒绝。

## 自动测试

封边专项 **13/13** 已通过：

- 四方向、角房、36 面及 32 房范围；逐格确认只改面向封闭过道的边。
- 开放过道跳过；highway、旧区块、中央九房、内部 terrain 和 sector 元数据不变。
- 新初始化封边和 exit 标记；旧版本地图只读预览与补丁。
- 两份 room buffer、已占用 Controller、建筑、tick、冷却、开放集合、原备份、日志与成绩保持。
- 重复/并发只写一次、首次备份保留、异常写入后重试；停服及不完整地图保护。
- 四方向实际 Creep 移动：封墙后无法进入出口格；相同场景不封墙的正对照会真实跨房间。
- 真实 CLI 跨进程预览、补墙和重复执行。

在双 mod 的独立测试目录复测：

```bash
node --experimental-vm-modules \
  /Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/xxscreeps.js \
  test "season-2 highway exits"
```

应为 13 项全部通过，不是 `0 tests`；CLI 集成测试需要临时 IPC socket 权限。

最终串行专项：封边 13/13、落地 25/25、地图 27/27、配置/加载 20/20、双 mod 下旧赛季及公共比赛 95/95。地图由原来的 26 项变为 27 项，是把真实 CLI 初始化和重复/恢复测试拆开，保持每项低于测试框架 10 秒限额；新 CLI 补墙测试也拆为预览与持久化两项，避免改变框架或降低校验。严格 ESLint 覆盖赛季 2 及地图脚本，旧测试文件零 error、保留原有同名 16 项 warning，没有新增。

最终完整回归：默认配置 **667/667**；仅旧 mod **740/761**；双 mod **825/846**。后两者均有 **21 项既有失败**，名称及顺序完全相同，也与第 4 步原始 22 项基线扣除已修正的 padding 比较项后完全一致，**没有新增失败，但完整混跑并非全部通过**。首次完整回归还暴露了 CLI 用例累计超时；压缩测试夹具的进程启动次数后串行复测通过，不修改运行代码或框架时限。TypeScript 编译通过。

测试日志目录：`/private/tmp/xxscreeps-season2-highways.df2Jqe`。没有操作线上地图。

## 用户验收

- [x] 预览范围正确，已有落地现场补墙不重置建筑或比赛数据。
- [x] 外围房间朝封闭过道的整条边界为墙，exit 中对应方向消失。
- [x] 中央九房、内部连接、旧赛季和 highway 状态不变。
- [x] E3N3 落地依然正常，重复补墙/重启不重拍地图。
- [x] 用户确认本补充通过，授权进入第 5 步。
