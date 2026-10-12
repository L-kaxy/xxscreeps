import type { MapReport } from './map.js';
import type { Set as SetOptions, Value } from 'xxscreeps/engine/db/storage/provider.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import * as RoomSchema from 'xxscreeps/engine/db/room.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardInitializers } from 'xxscreeps/engine/processor/shard.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { World, schema as worldSchema } from 'xxscreeps/game/map.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { getBuffer } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { Mineral } from 'xxscreeps/mods/classic/mineral/mineral.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { StructureKeeperLair } from 'xxscreeps/mods/classic/source/keeper-lair.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializeSeason2Map, mapOpenRoomsBackupKey, mapStateKey, mapTerrainBackupKey, previewSeason2Map, restoreSeason2Map } from './map.js';
import { buildSeason2Map, originalMap, season2MapRooms, translateOriginalRoom, translatedObjectId } from './original-map.js';

const stopped = { serverStopped: true };
const fresh = simulate({});
const makeMap = () => buildSeason2Map(new Set());
const command = promisify(execFile);
const binary = fileURLToPath(new URL('../../../xxscreeps.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../test/data/shard.json', import.meta.url));
const stateOf = (raw: string | null) => (JSON.parse(raw!) as { state: string }).state;

/** No real server data is copied: each CLI test starts in a fresh temporary directory. */
async function withCli<Type>(mods: string[], task: (run: (...args: string[]) => Promise<string>) => Promise<Type>) {
	// Keep Unix socket paths below macOS' length limit, including ".shard0.pubsub".
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xs2-'));
	try {
		await fs.writeFile(path.join(directory, '.screepsrc.yaml'), JSON.stringify({ mods, runner: { sandbox: 'unsafe' } }));
		return await task(async (...args) => {
			const { stdout } = await command(process.execPath, [ '--experimental-vm-modules', binary, ...args ], {
				cwd: directory, timeout: 8000, maxBuffer: 1024 * 1024,
			});
			return stdout;
		});
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe('season-2 map', () => {
	test('the packaged asset contains 81 terrain records and only 335 initial map objects', () => {
		assert.strictEqual(originalMap.format, 1);
		assert.strictEqual(originalMap.source.version, '4.2.0');
		assert.strictEqual(originalMap.source.sha256, '327d73d39efa91a09d64e6088e006a60f4d1ad5cef7105c35076a5dcd83efb54');
		assert.strictEqual(Object.keys(originalMap.rooms).length, 81);
		const counts: Record<string, number> = {};
		for (const room of Object.values(originalMap.rooms)) {
			assert.match(room.terrain, /^[0-3]{2500}$/);
			for (const object of room.objects) {
				counts[object.type] = (counts[object.type] ?? 0) + 1;
				assert.ok(!('user' in object) && !('level' in object) && !('safeMode' in object));
			}
		}
		assert.deepStrictEqual(counts, { controller: 72, source: 141, mineral: 81, keeperLair: 32, extractor: 9 });
	});

	test('every source room moves eleven signed coordinates east, not a mirror', () => {
		assert.strictEqual(translateOriginalRoom('W7N3'), 'E3N3');
		assert.strictEqual(translateOriginalRoom('W9N9'), 'E1N9');
		assert.strictEqual(translateOriginalRoom('W1N1'), 'E9N1');
		assert.strictEqual(new Set(season2MapRooms).size, 81);
		for (const from of Object.keys(originalMap.rooms)) {
			const before = parseSignedRoomName(from);
			const after = parseSignedRoomName(translateOriginalRoom(from));
			assert.strictEqual(after.rx - before.rx, 11);
			assert.strictEqual(after.ry, before.ry);
		}
		for (const name of [ 'W0N0', 'W10N1', 'E3N3', 'W3N10' ]) {
			assert.throws(() => translateOriginalRoom(name), /Not an original interior/);
		}
	});

	test('all 202500 tiles are copied exactly, including natural-object tiles', () => {
		const { terrain } = makeMap();
		for (const [ name, original ] of Object.entries(originalMap.rooms)) {
			const copied = terrain.get(translateOriginalRoom(name))!.terrain;
			for (let index = 0; index < 2500; ++index) {
				assert.strictEqual(copied.get(index % 50, Math.floor(index / 50)), Number(original.terrain[index]), `${name}:${index}`);
			}
		}
	});

	test('every initial object keeps its type, tile, resource fields and translated room', () => {
		const { rooms } = makeMap();
		const types = { source: Source, mineral: Mineral, controller: StructureController, keeperLair: StructureKeeperLair, extractor: StructureExtractor };
		const ids = new Set<string>();
		for (const [ name, original ] of Object.entries(originalMap.rooms)) {
			const room = rooms.find(room => room.name === translateOriginalRoom(name))!;
			assert.strictEqual(room['#objects'].length, original.objects.length);
			for (const [ index, info ] of original.objects.entries()) {
				const object = room['#objects'][index]!;
				assert.ok(object instanceof types[info.type]);
				assert.deepStrictEqual([ object.pos.x, object.pos.y, object.pos.roomName ], [ info.x, info.y, room.name ]);
				assert.strictEqual(object['#posId'], object.pos['#id']);
				assert.match(object.id, /^[0-9a-f]{24}$/);
				assert.notStrictEqual(object.id, info.id);
				assert.ok(!ids.has(object.id));
				ids.add(object.id);
				if (object instanceof Source) {
					assert.strictEqual(object.energy, info.energy);
					assert.strictEqual(object.energyCapacity, info.energyCapacity);
				} else if (object instanceof Mineral) {
					assert.deepStrictEqual([ object.mineralType, object.mineralAmount, object.density ],
						[ info.mineralType, info.mineralAmount, info.density ]);
				}
			}
		}
		assert.strictEqual(ids.size, 335);
	});

	test('E3N3 is the original W7N3 layout with no bot spawn or controller ownership', () => {
		const room = makeMap().rooms.find(room => room.name === 'E3N3')!;
		assert.deepStrictEqual(room['#objects'].map(object => [ object.pos.x, object.pos.y ]), [ [ 41, 3 ], [ 38, 6 ], [ 36, 18 ], [ 24, 29 ] ]);
		for (const room of makeMap().rooms) {
			assert.strictEqual(room['#user'], room['#level'] === 0 ? null : undefined);
			assert.ok(room['#level'] === 0 || room['#level'] === -1);
			for (const object of room['#objects']) {
				assert.strictEqual(object['#user'], object instanceof StructureKeeperLair ? '3' : null);
			}
		}
	});

	test('occupied generated IDs are re-salted instead of reused', () => {
		const info = originalMap.rooms.W7N3!.objects[0]!;
		const first = translatedObjectId('E3N3', info.id);
		const second = translatedObjectId('E3N3', info.id, 1);
		const map = buildSeason2Map(new Set(), new Set([ first, second ]));
		const copied = map.rooms.find(room => room.name === 'E3N3')!['#objects'][0]!;
		assert.strictEqual(copied.id, translatedObjectId('E3N3', info.id, 2));
	});

	test('new sector references use E rooms and existing highways without creating or opening them', () => {
		const existing = new Set([ 'W5N5', 'E0N5', 'E10N5', 'E5N0', 'E5N10' ]);
		const { terrain } = buildSeason2Map(existing);
		const center = terrain.get('E5N5')!;
		assert.strictEqual(center.sectorControl!.members.length, 81);
		assert.deepStrictEqual(new Set(center.sectorControl!.edges), new Set([ 'E0N5', 'E10N5', 'E5N0', 'E5N10' ]));
		assert.deepStrictEqual(terrain.get('E3N3')!.sectors, [ 'E5N5' ]);
		assert.strictEqual(terrain.size, 81);
		assert.strictEqual(existing.size, 5);
		assert.ok(center.sectorControl!.members.every(name => /^E[1-9]N[1-9]$/.test(name)));
	});

	test('preview writes no terrain, room buffers, journal, backup, open state or clock', () => fresh(async ({ shard }) => {
		const before = await shard.data.req('terrain', { blob: true });
		const open = (await shard.data.sMembers('rooms')).sort();
		const time = await shard.data.get('time');
		const preview = await previewSeason2Map(shard);
		assert.deepStrictEqual([ preview.state, preview.written, preview.rooms, preview.objects ], [ 'ready', false, 81, 335 ]);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		assert.deepStrictEqual((await shard.data.sMembers('rooms')).sort(), open);
		assert.strictEqual(await shard.data.get('time'), time);
		for (const key of [ mapStateKey, mapTerrainBackupKey, mapOpenRoomsBackupKey ]) {
			assert.strictEqual(await shard.data.get(key), null);
		}
		for (const name of season2MapRooms) {
			assert.strictEqual(await shard.data.get(`room0/${name}`, { blob: true }), null);
			assert.strictEqual(await shard.data.get(`room1/${name}`, { blob: true }), null);
		}
	}));

	test('all four existing highway sides retain their closed status and original terrain', () => fresh(async ({ shard }) => {
		const highways = [ 'E0N5', 'E10N5', 'E5N0', 'E5N10' ];
		const world = await shard.loadWorld();
		const tiles = [ ...getBuffer(world.terrain.get('W0N5')!.terrain) ];
		for (const name of highways) {
			world.terrain.set(name, world.terrain.get('W0N5')!);
		}
		await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
		await initializeSeason2Map(shard, stopped);
		const after = await shard.loadWorld();
		for (const name of highways) {
			assert.strictEqual(after.map.getRoomStatus(name).status, 'closed');
			assert.deepStrictEqual([ ...getBuffer(after.terrain.get(name)!.terrain) ], tiles);
			assert.strictEqual(await shard.data.get(`room0/${name}`, { blob: true }), null);
		}
		assert.deepStrictEqual(new Set(after.terrain.get('E5N5')!.sectorControl!.edges), new Set(highways));
	}));

	test('initialization preserves all old terrain, both old room buffers, opening state and race data', () => fresh(async ({ shard }) => {
		await runShardInitializers(shard);
		const world = await shard.loadWorld();
		const open = new Set(await shard.data.sMembers('rooms'));
		const blobs = new Map<string, Readonly<Uint8Array> | null>();
		for (const name of world.terrain.keys()) {
			for (const slot of [ 0, 1 ]) {
				blobs.set(`room${slot}/${name}`, await shard.data.get(`room${slot}/${name}`, { blob: true }));
			}
		}
		await shard.db.data.hSet('speedrun/run/100', 'run', '17');
		await shard.db.data.hSet('speedrun/score/20000/100:16', 'controlPoints', '46200');
		await shard.data.zAdd('speedrun/due', [ [ 20000, '100:17:20000' ] ]);
		await shard.data.zAdd('speedrun/racing', [ [ 0, '100:17' ] ]);
		await shard.scratch.set('old-test-scratch', 'preserve');
		const oldUsers = (await shard.db.data.sMembers('users')).sort();
		const time = await shard.data.get('time');
		const result = await initializeSeason2Map(shard, stopped);
		assert.strictEqual(result.written, true);
		const after = await shard.loadWorld();
		for (const [ name, record ] of world.terrain) {
			const copied = after.terrain.get(name)!;
			assert.deepStrictEqual([ ...getBuffer(copied.terrain) ], [ ...getBuffer(record.terrain) ], name);
			assert.deepStrictEqual([ copied.exits, copied.sectors, copied.sectorControl ], [ record.exits, record.sectors, record.sectorControl ], name);
			assert.strictEqual(after.map.getRoomStatus(name).status, open.has(name) ? 'normal' : 'closed');
		}
		for (const [ key, value ] of blobs) {
			assert.deepStrictEqual(await shard.data.get(key, { blob: true }), value, key);
		}
		assert.deepStrictEqual(await shard.data.req(mapTerrainBackupKey, { blob: true }), world.terrainBlob);
		assert.deepStrictEqual(new Set(JSON.parse((await shard.data.get(mapOpenRoomsBackupKey))!) as string[]), open);
		assert.strictEqual(await shard.db.data.hGet('speedrun/run/100', 'run'), '17');
		assert.strictEqual(await shard.db.data.hGet('speedrun/score/20000/100:16', 'controlPoints'), '46200');
		assert.deepStrictEqual(await shard.data.zRange('speedrun/due', 0, -1), [ '100:17:20000' ]);
		assert.deepStrictEqual(await shard.data.zRange('speedrun/racing', 0, -1), [ '100:17' ]);
		assert.deepStrictEqual((await shard.db.data.sMembers('users')).sort(), oldUsers);
		assert.strictEqual(await shard.scratch.get('old-test-scratch'), 'preserve');
		assert.strictEqual(await shard.data.get('time'), time);
		assert.strictEqual(await shard.db.data.hGet('speedrun-season2/run/100', 'run'), null);
	}));

	test('all new rooms have matching double buffers at an existing odd tick without resetting time', () => fresh(async ({ shard }) => {
		shard.time = 701;
		await shard.data.set('time', 701);
		await initializeSeason2Map(shard, stopped);
		assert.strictEqual(shard.time, 701);
		assert.strictEqual(await shard.data.get('time'), '701');
		for (const name of season2MapRooms) {
			const left = await shard.data.req(`room0/${name}`, { blob: true });
			const right = await shard.data.req(`room1/${name}`, { blob: true });
			assert.deepStrictEqual(left, right);
			const room = await shard.loadRoom(name);
			assert.strictEqual(room.name, name);
			assert.strictEqual(room.controller?.level ?? -1, room['#level']);
		}
	}));

	test('the old startup hooks do not close, wall or reinitialize any of the new center nine', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const before = await shard.data.req('room0/E5N5', { blob: true });
		await runShardInitializers(shard);
		await runShardInitializers(shard);
		const world = await shard.loadWorld();
		for (let xx = 4; xx <= 6; ++xx) {
			for (let yy = 4; yy <= 6; ++yy) {
				const name = `E${xx}N${yy}`;
				assert.strictEqual(world.map.getRoomStatus(name).status, 'normal');
				assert.deepStrictEqual(world.terrain.get(name)!.terrain.getRawBuffer(),
					Uint8Array.from(originalMap.rooms[`W${10 - xx}N${yy}`]!.terrain, Number));
			}
		}
		assert.deepStrictEqual(await shard.data.req('room0/E5N5', { blob: true }), before);
	}));

	test('all center-nine rooms run their normal resource and keeper tick processors', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		await runShardInitializers(shard);
		const world = await shard.loadWorld();
		for (let xx = 4; xx <= 6; ++xx) {
			for (let yy = 4; yy <= 6; ++yy) {
				const room = await shard.loadRoom(`E${xx}N${yy}`);
				const source = room['#objects'].find(object => object instanceof Source)!;
				source.energy = 0;
				const processor = new RoomProcessor(shard, world, room, shard.time);
				await processor.process();
				assert.ok(source['#nextRegenerationTime'] > shard.time);
				for (const object of room['#objects']) {
					if (object instanceof StructureKeeperLair) {
						assert.ok(object['#nextSpawnTime'] > shard.time);
					}
				}
			}
		}
	}));

	test('existing IDs in the old previous buffer are also excluded by the real writer', () => fresh(async ({ shard }) => {
		const id = translatedObjectId('E3N3', originalMap.rooms.W7N3!.objects[0]!.id);
		const blob = await shard.data.req('room1/W7N3', { blob: true });
		const room = RoomSchema.read(blob);
		room['#objects'][0]!.id = id;
		await shard.data.set('room1/W7N3', RoomSchema.write(room));
		await initializeSeason2Map(shard, stopped);
		const added = await shard.loadRoom('E3N3');
		assert.ok(added['#objects'].every(object => object.id !== id));
		assert.strictEqual(RoomSchema.read(await shard.data.req('room1/W7N3', { blob: true }))['#objects'][0]!.id, id);
	}));

	test('repeating initialization is a no-op even after the new map changes', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const room = await shard.loadRoom('E3N3');
		runOneShot(await shard.loadWorld(), room, shard.time, '', () => {
			room['#insertObject'](createRoad(new RoomPosition(20, 20, room.name)));
			room['#flushObjects'](null);
		});
		await shard.data.set('room0/E3N3', RoomSchema.write(room));
		const before = await shard.data.req('room0/E3N3', { blob: true });
		const result = await initializeSeason2Map(shard, stopped);
		assert.deepStrictEqual([ result.state, result.written ], [ 'complete', false ]);
		assert.deepStrictEqual(await shard.data.req('room0/E3N3', { blob: true }), before);
	}));

	test('target terrain, open membership or either buffer blocks the first write before any backup', () => fresh(async ({ shard }) => {
		const world = await shard.loadWorld();
		world.terrain.set('E1N1', makeMap().terrain.get('E1N1')!);
		await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain));
		await shard.data.set('room1/E1N2', RoomSchema.write(makeMap().rooms.find(room => room.name === 'E1N2')!));
		await shard.data.sAdd('rooms', [ 'E1N3' ]);
		const before = await shard.data.req('terrain', { blob: true });
		const preview = await previewSeason2Map(shard);
		assert.deepStrictEqual(preview.conflicts, [ 'E1N1', 'E1N2', 'E1N3' ]);
		await assert.rejects(() => initializeSeason2Map(shard, stopped), /refusing to overwrite/);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		assert.strictEqual(await shard.data.get(mapStateKey), null);
		assert.strictEqual(await shard.data.get(mapTerrainBackupKey), null);
	}));

	test('writes require stopped acknowledgement and refuse an actually held main lock', () => fresh(async ({ shard }) => {
		await assert.rejects(() => initializeSeason2Map(shard, { serverStopped: false }), /server-stopped/);
		await assert.rejects(() => restoreSeason2Map(shard, { serverStopped: false }), /server-stopped/);
		await using mutex = await Mutex.connect('main', shard.data, shard.pubsub);
		await using lock = await mutex.acquire();
		await assert.rejects(() => initializeSeason2Map(shard, stopped), /still running/);
		assert.strictEqual(await shard.data.get(mapStateKey), null);
	}));

	test('two explicit initializers serialize to one addition and one no-op', () => fresh(async ({ shard }) => {
		const before = (await shard.loadWorld()).terrain.size;
		const open = await shard.data.sCard('rooms');
		const results = await Promise.all([ initializeSeason2Map(shard, stopped), initializeSeason2Map(shard, stopped) ]);
		assert.deepStrictEqual(results.map(result => result.written).sort((left, right) => Number(left) - Number(right)), [ false, true ]);
		assert.strictEqual((await shard.loadWorld()).terrain.size, before + 81);
		assert.strictEqual(await shard.data.sCard('rooms'), open + 81);
	}));

	test('rollback removes only the added block and preserves later old-world edits and scores', () => fresh(async ({ shard }) => {
		const before = await shard.data.req('terrain', { blob: true });
		const originalWorld = new World(shard.name, before);
		await initializeSeason2Map(shard, stopped);
		const changed = await shard.loadWorld();
		const previous = changed.terrain.get('W7N3')!.terrain.get(20, 20);
		const packed = getBuffer(changed.terrain.get('W7N3')!.terrain);
		packed[(20 * 50 + 20) >>> 2]! ^= 1;
		await shard.data.set('terrain', makeWriter(worldSchema)(changed.terrain));
		await shard.db.data.hSet('speedrun/score/20000/100:99', 'controlPoints', '999999');
		const restored = await restoreSeason2Map(shard, stopped);
		assert.strictEqual(restored.written, true);
		const world = await shard.loadWorld();
		assert.strictEqual(world.terrain.size, originalWorld.terrain.size);
		assert.strictEqual(world.terrain.get('W7N3')!.terrain.get(20, 20), previous ^ 1);
		assert.strictEqual(await shard.db.data.hGet('speedrun/score/20000/100:99', 'controlPoints'), '999999');
		for (const name of season2MapRooms) {
			assert.ok(!world.terrain.has(name));
			assert.strictEqual(await shard.data.sIsMember('rooms', name), false);
			assert.strictEqual(await shard.data.get(`room0/${name}`, { blob: true }), null);
			assert.strictEqual(await shard.data.get(`room1/${name}`, { blob: true }), null);
		}
		assert.strictEqual((await restoreSeason2Map(shard, stopped)).written, false);
		assert.strictEqual((await initializeSeason2Map(shard, stopped)).written, true);
	}));

	test('rollback checks both buffers and refuses new buildings before deleting anything', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const room = await shard.loadRoom('E9N9');
		runOneShot(await shard.loadWorld(), room, shard.time, '', () => {
			room['#insertObject'](createRoad(new RoomPosition(20, 20, room.name)));
			room['#flushObjects'](null);
		});
		await shard.data.set('room1/E9N9', RoomSchema.write(room));
		const before = await shard.data.req('terrain', { blob: true });
		await assert.rejects(() => restoreSeason2Map(shard, stopped), /gameplay changes/);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		assert.ok(await shard.data.get('room0/E1N1', { blob: true }));
		assert.strictEqual(stateOf(await shard.data.get(mapStateKey)), 'complete');
	}));

	test('rollback refuses a claimed controller even if all object IDs are still original', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const room = await shard.loadRoom('E3N3');
		room['#user'] = room.controller!['#user'] = '100';
		room['#level'] = 1;
		await shard.data.set('room0/E3N3', RoomSchema.write(room));
		await assert.rejects(() => restoreSeason2Map(shard, stopped), /gameplay changes/);
	}));

	test('rollback allows generated keeper NPCs but never removes a visiting player creep', async () => {
		for (const owner of [ '3', '100' ]) {
			await fresh(async ({ shard }) => {
				await initializeSeason2Map(shard, stopped);
				const world = await shard.loadWorld();
				const room = await shard.loadRoom('E4N4');
				runOneShot(world, room, shard.time, '', () => {
					room['#insertObject'](createCreep(new RoomPosition(20, 20, room.name), [ C.MOVE ], 'visitor', owner));
					room['#flushObjects'](null);
				});
				await shard.data.set('room0/E4N4', RoomSchema.write(room));
				if (owner === '3') {
					assert.strictEqual((await restoreSeason2Map(shard, stopped)).written, true);
					assert.strictEqual(await shard.data.get('room0/E4N4', { blob: true }), null);
				} else {
					await assert.rejects(() => restoreSeason2Map(shard, stopped), /gameplay changes/);
					assert.ok((await shard.loadWorld()).terrain.has('E4N4'));
				}
			});
		}
	});

	test('a failed addition leaves a durable prepared journal and requires explicit recovery', () => fresh(async ({ shard }) => {
		const before = await shard.data.req('terrain', { blob: true });
		const originalSet = shard.data.set.bind(shard.data);
		shard.data.set = (async (key: string, value: Value, options?: SetOptions) => {
			if (key === 'room1/E3N3') {
				throw new Error('injected write failure');
			}
			return originalSet(key, value, options);
		}) as typeof shard.data.set;
		try {
			await assert.rejects(() => initializeSeason2Map(shard, stopped), /injected write failure/);
		} finally {
			shard.data.set = originalSet;
		}
		assert.strictEqual(stateOf(await shard.data.get(mapStateKey)), 'prepared');
		assert.deepStrictEqual(await shard.data.req(mapTerrainBackupKey, { blob: true }), before);
		assert.strictEqual((await previewSeason2Map(shard)).state, 'prepared');
		await assert.rejects(() => initializeSeason2Map(shard, stopped), /incomplete map/);
		assert.strictEqual((await restoreSeason2Map(shard, stopped)).written, true);
		// The serializer's padding bytes need not match; every terrain and metadata field must.
		const restored = await shard.loadWorld();
		const original = new World(shard.name, before);
		assert.deepStrictEqual(makeWriter(worldSchema)(restored.terrain, true), makeWriter(worldSchema)(original.terrain, true));
		assert.strictEqual((await initializeSeason2Map(shard, stopped)).written, true);
	}));

	test('the CLI refuses a missing mod and write acknowledgement before connecting to an empty store', () =>
		withCli([ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun' ], async run => {
			await assert.rejects(() => run('season2-map', '--initialize', '--server-stopped'), /Enable xxscreeps/);
		}));

	test('the CLI rejects ambiguous actions and unacknowledged writes', () =>
		withCli([ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ], async run => {
			await assert.rejects(() => run('season2-map', '--initialize'), /Stop all services/);
			await assert.rejects(() => run('season2-map', '--initialize', '--dry-run'), /Usage:/);
		}));

	test('the real CLI previews, initializes, persists across processes and restores a temporary shard', () =>
		withCli([ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ], async run => {
			await run('import', fixture);
			const preview = JSON.parse(await run('season2-map')) as MapReport;
			assert.deepStrictEqual([ preview.state, preview.written, preview.rooms, preview.objects ], [ 'ready', false, 81, 335 ]);
			const initialized = JSON.parse(await run('season2-map', '--initialize', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ initialized.state, initialized.written ], [ 'complete', true ]);
			const repeated = JSON.parse(await run('season2-map', '--initialize', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ repeated.state, repeated.written ], [ 'complete', false ]);
			const restored = JSON.parse(await run('season2-map', '--restore', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ restored.state, restored.written ], [ 'restored', true ]);
		}));
});
