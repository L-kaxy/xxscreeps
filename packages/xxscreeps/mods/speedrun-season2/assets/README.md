# 赛季 2 固定地图资源

`original-map.json` 来自本机原版私服发行包，不来自已经被赛季 1 改造的现场地图：

```text
/Users/jason/workspace/nodejs/screeps-server-mockup/node_modules/@screeps/launcher/init_dist/db.json
```

- 来源：`@screeps/launcher`，版本 `4.2.0`，文件 `init_dist/db.json`。
- 原文件 SHA-256：`327d73d39efa91a09d64e6088e006a60f4d1ad5cef7105c35076a5dcd83efb54`。
- 本资源 SHA-256：`e289d4aac260ce33cb7b5dcf922701ad08073ffc75439512d9fa224f6ef91d73`。
- 上游许可 ISC；版权及许可原文保留在 JSON 的 `license.notice` 中，并另存于同目录 `LICENSE.original-map.txt`，编译后的 JSON 也携带许可。

## 提取内容

从原数据库的 Loki `collections` 中，仅取：

- `rooms.terrain` 的 `W1N1～W9N9`：81 个房间，每房 2500 个数字字符，顺序、墙、平地和沼泽完全不变。
- `rooms.objects` 同范围的初始地图布局：141 个 Source、72 个 Controller、81 个 Mineral、32 个 Keeper Lair、9 个中立 Extractor，共 335 个对象。保留原 ID 作为映射输入、类型及房内 `(x, y)`。
- Source 保留原能量和容量；Mineral 保留类型、密度和数量。原矿量是浮点数，按引擎 int32 格式截去小数，不重新随机生成。

不提取四个机器人 Spawn，不导入账号、代码、市场、建筑运行状态、Controller 原机器人所有权或安全模式。Controller 在新区块为无主 RCL 0；无 Controller 的中央九房为 `#level = -1`。NPC Keeper Lair 使用引擎已有 Source Keeper 身份。

运行时计时器按引擎新对象的默认状态开始，不搬运原数据库的历史绝对 tick。初始自然对象 ID 经新区块命名空间重新生成，并避开现有地图两份房间缓冲中的对象 ID。

## 转换和部署

资源保留原 `W` 房名，初始化时由 [original-map.ts](/Users/jason/workspace/nodejs/xxscreeps/packages/xxscreeps/mods/speedrun-season2/original-map.ts) 做 `W{x}N{y} → E{10-x}N{y}` 平移。不镜像房内坐标，不跑地图生成器、出口修复或连通性校验。

资源通过静态 JSON import 随 TypeScript 构建复制到 `dist`。部署只需要本仓库及正常构建产物，**不访问开发机的原版私服目录**。

本次已对原始数据库逐项核对：81 房、202500 个地形格及 335 个初始对象的类型与坐标一致。原库只用于提取及本次核对，自动测试和部署不依赖它。
