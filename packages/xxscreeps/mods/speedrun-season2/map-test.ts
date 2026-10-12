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
import { TerrainWriter, getBuffer, packExits } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { Mineral } from 'xxscreeps/mods/classic/mineral/mineral.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { StructureKeeperLair } from 'xxscreeps/mods/classic/source/keeper-lair.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { closedHighwayFaces, planHighwaySealing } from './highways.js';
import { highwayTerrainBackupKey, initializeSeason2Map, mapOpenRoomsBackupKey, mapStateKey, mapTerrainBackupKey, previewHighwaySealing, previewSeason2Map, restoreSeason2Map, sealSeason2Highways } from './map.js';
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
			const raw = copied.getRawBuffer();
			for (let index = 0; index < 2500; ++index) {
				const mask = Number(original.terrain[index]);
				assert.strictEqual(raw[index], mask, `${name}:${index} preserves the original mask`);
				assert.strictEqual(copied.get(index % 50, Math.floor(index / 50)),
					mask & C.TERRAIN_MASK_WALL ? C.TERRAIN_MASK_WALL : mask, `${name}:${index} gives wall priority`);
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
			await assert.rejects(() => run('season2-map', '--seal-highways'), /Stop all services/);
			await assert.rejects(() => run('season2-map', '--seal-highways', '--initialize', '--server-stopped'), /Usage:/);
		}));

	test('the real CLI previews and initializes a temporary shard across processes', () =>
		withCli([ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ], async run => {
			await run('import', fixture);
			const preview = JSON.parse(await run('season2-map')) as MapReport;
			assert.deepStrictEqual([ preview.state, preview.written, preview.rooms, preview.objects ], [ 'ready', false, 81, 335 ]);
			const initialized = JSON.parse(await run('season2-map', '--initialize', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ initialized.state, initialized.written ], [ 'complete', true ]);
		}));

	test('the real CLI repeats initialization without rewriting rooms', () =>
		withInitializedCli(async run => {
			const repeated = JSON.parse(await run('season2-map', '--initialize', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ repeated.state, repeated.written ], [ 'complete', false ]);
		}));

	test('the real CLI restores an initialized temporary shard', () =>
		withInitializedCli(async run => {
			const restored = JSON.parse(await run('season2-map', '--restore', '--server-stopped')) as MapReport;
			assert.deepStrictEqual([ restored.state, restored.written ], [ 'restored', true ]);
		}));
});

/** Emulate the previous initialized version without repainting any saved room or object. */
async function legacyTerrain(shard: import('xxscreeps/engine/db/shard.js').Shard) {
	await initializeSeason2Map(shard, stopped);
	const world = await shard.loadWorld();
	for (const [ name, record ] of buildSeason2Map(new Set(world.terrain.keys())).terrain) {
		world.terrain.set(name, record);
	}
	await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
	return world;
}

/** One fixture process per CLI case keeps each test below the runner's 10-second budget. */
function withInitializedCli<Type>(task: (run: (...args: string[]) => Promise<string>) => Promise<Type>, legacy = false) {
	return withCli([ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ], async run => {
		await run('eval', '-e', `(async () => {
			const {readFile}=await import('node:fs/promises');
			const {Database, Shard}=await import('xxscreeps/engine/db/index.js');
			const {config}=await import('xxscreeps/config/index.js');
			const {importPayload,seedShard}=await import('xxscreeps/scripts/payload.js');
			const {initializeSeason2Map}=await import('xxscreeps/mods/speedrun-season2/map.js');
			const {buildSeason2Map}=await import('xxscreeps/mods/speedrun-season2/original-map.js');
			const {schema}=await import('xxscreeps/game/map.js');
			const {makeWriter}=await import('xxscreeps/schema/write.js');
			await using db=await Database.connect();
			await using shard=await Shard.connect(db,config.shards[0].name);
			await seedShard(shard,importPayload(JSON.parse(await readFile(${JSON.stringify(fixture)},'utf8'))));
			await initializeSeason2Map(shard,{serverStopped:true});
			if (${legacy}) {
				const world=await shard.loadWorld();
				for(const [name,record] of buildSeason2Map(new Set(world.terrain.keys())).terrain)world.terrain.set(name,record);
				await shard.data.set('terrain',makeWriter(schema)(world.terrain,true));
			}
			await shard.save();
			return 'temporary initialized terrain';
		})()`);
		return task(run);
	});
}

function withLegacyCli<Type>(task: (run: (...args: string[]) => Promise<string>) => Promise<Type>) {
	return withInitializedCli(task, true);
}

describe('season-2 highway exits', () => {
	test('all four exterior directions and corner rooms face the correct highway', () => {
		const closed = new Set<string>();
		assert.deepStrictEqual(closedHighwayFaces('E1N9', closed), [
			{ room: 'E1N9', side: 'top', highway: 'E1N10' },
			{ room: 'E1N9', side: 'left', highway: 'E0N9' },
		]);
		assert.deepStrictEqual(closedHighwayFaces('E9N1', closed), [
			{ room: 'E9N1', side: 'right', highway: 'E10N1' },
			{ room: 'E9N1', side: 'bottom', highway: 'E9N0' },
		]);
		const plan = planHighwaySealing(makeMap().terrain, closed);
		assert.strictEqual(plan.faces.length, 36);
		assert.strictEqual(new Set(plan.faces.map(face => face.room)).size, 32);
		for (const name of [ 'W1N1', 'E0N3', 'E10N3', 'E3N0', 'E3N10', 'E3N3', 'E5N5', 'E1S1', 'E01N1' ]) {
			assert.deepStrictEqual(closedHighwayFaces(name, closed), [], name);
		}
	});

	test('only outward edges change; every other tile and the raw source buffer remain exact', () => {
		const { terrain } = makeMap();
		const before = new Map([ ...terrain ].map(([ name, record ]) => [ name, Uint8Array.from(getBuffer(record.terrain)) ]));
		const plan = planHighwaySealing(terrain, new Set());
		for (const [ name, record ] of terrain) {
			const after = plan.changes.get(name) ?? record;
			for (let yy = 0; yy < 50; ++yy) {
				for (let xx = 0; xx < 50; ++xx) {
					const outward = (name[1] === '1' && xx === 0) || (name[1] === '9' && xx === 49)
						|| (name[3] === '9' && yy === 0) || (name[3] === '1' && yy === 49);
					assert.strictEqual(after.terrain.get(xx, yy), outward ? 1 : record.terrain.get(xx, yy), `${name}:${xx},${yy}`);
				}
			}
			assert.strictEqual(after.exits, packExits(after.terrain));
			assert.deepStrictEqual(getBuffer(record.terrain), before.get(name), 'copy-on-write preserves preview inputs');
			assert.deepStrictEqual(after.sectors, record.sectors);
			assert.deepStrictEqual(after.sectorControl, record.sectorControl);
		}
	});

	test('an open highway is never sealed, and highways and season 1 are never modified', () => {
		const { terrain } = makeMap();
		const old = terrain.get('E1N3')!;
		terrain.set('W1N1', old);
		terrain.set('E0N3', old);
		const plan = planHighwaySealing(terrain, new Set([ 'E0N3' ]));
		assert.strictEqual(plan.faces.length, 35);
		assert.strictEqual(plan.changes.has('E1N3'), false);
		assert.strictEqual(plan.changes.has('W1N1'), false);
		assert.strictEqual(plan.changes.has('E0N3'), false);
		assert.ok(plan.changes.has('E1N2'));
	});

	test('fresh initialization seals exterior tiles and exit metadata without closing any season-2 room', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const world = await shard.loadWorld();
		const preview = await previewHighwaySealing(shard);
		assert.deepStrictEqual([ preview.rooms, preview.edges, preview.written, preview.changedRooms.length ], [ 32, 36, false, 0 ]);
		for (const name of season2MapRooms) {
			assert.strictEqual(world.map.getRoomStatus(name).status, 'normal');
			const exits = world.map.describeExits(name)!;
			if (name[1] === '1') { assert.strictEqual(exits[7], undefined); }
			if (name[1] === '9') { assert.strictEqual(exits[3], undefined); }
			if (name[3] === '1') { assert.strictEqual(exits[5], undefined); }
			if (name[3] === '9') { assert.strictEqual(exits[1], undefined); }
		}
	}));

	test('preview of a legacy initialized map makes no writes, including backup and terrain padding', () => fresh(async ({ shard }) => {
		await legacyTerrain(shard);
		const before = await shard.data.req('terrain', { blob: true });
		const journal = await shard.data.get(mapStateKey);
		const preview = await previewHighwaySealing(shard);
		assert.strictEqual(preview.edges, 36);
		assert.ok(preview.changedRooms.length > 0);
		assert.strictEqual(preview.written, false);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		assert.strictEqual(await shard.data.get(mapStateKey), journal);
		assert.strictEqual(await shard.data.get(highwayTerrainBackupKey, { blob: true }), null);
	}));

	test('retrofit protects all room buffers, occupants, clock, highway state, old terrain and scores', () => fresh(async ({ shard }) => {
		await legacyTerrain(shard);
		const room = await shard.loadRoom('E3N3');
		room['#user'] = room.controller!['#user'] = '100';
		room['#level'] = 1;
		runOneShot(await shard.loadWorld(), room, shard.time, '', () => {
			room['#insertObject'](createSpawn(new RoomPosition(2, 2, room.name), '100', 'PreservedSpawn'));
			room['#insertObject'](createRoad(new RoomPosition(20, 20, room.name)));
			room['#flushObjects'](null);
		});
		await shard.saveRoom(room.name, shard.time, room);
		await shard.data.hSet('user/100', 'lastSpawnTime', '123');
		await shard.db.data.hSet('speedrun/score/20000/100:1', 'controlPoints', '46200');
		await shard.db.data.hSet('speedrun-season2/run/100', 'marker', 'preserve');
		await shard.data.zAdd('speedrun-season2/due', [ [ 99999, 'preserve' ] ]);
		const world = await shard.loadWorld();
		const before = Uint8Array.from(world.terrainBlob);
		const blobs = new Map<string, Readonly<Uint8Array> | null>();
		for (const name of world.terrain.keys()) {
			for (const slot of [ 0, 1 ]) {
				const key = `room${slot}/${name}`;
				blobs.set(key, await shard.data.get(key, { blob: true }));
			}
		}
		const open = (await shard.data.sMembers('rooms')).sort();
		const journal = await shard.data.get(mapStateKey);
		const initBackup = await shard.data.req(mapTerrainBackupKey, { blob: true });
		const time = await shard.data.get('time');
		assert.strictEqual((await sealSeason2Highways(shard, stopped)).written, true);
		const after = await shard.loadWorld();
		const changed = new Set(planHighwaySealing(world.terrain, new Set(open)).changes.keys());
		for (const [ name, record ] of world.terrain) {
			if (!changed.has(name)) {
				assert.deepStrictEqual(getBuffer(after.terrain.get(name)!.terrain), getBuffer(record.terrain), name);
			}
			assert.strictEqual(after.map.getRoomStatus(name).status, world.map.getRoomStatus(name).status);
		}
		for (const [ key, value ] of blobs) {
			assert.deepStrictEqual(await shard.data.get(key, { blob: true }), value, key);
		}
		assert.deepStrictEqual(await shard.data.req(highwayTerrainBackupKey, { blob: true }), before);
		assert.deepStrictEqual(await shard.data.req(mapTerrainBackupKey, { blob: true }), initBackup);
		assert.deepStrictEqual((await shard.data.sMembers('rooms')).sort(), open);
		assert.strictEqual(await shard.data.get(mapStateKey), journal);
		assert.strictEqual(await shard.data.get('time'), time);
		assert.strictEqual(await shard.data.hGet('user/100', 'lastSpawnTime'), '123');
		assert.strictEqual(await shard.db.data.hGet('speedrun/score/20000/100:1', 'controlPoints'), '46200');
		assert.strictEqual(await shard.db.data.hGet('speedrun-season2/run/100', 'marker'), 'preserve');
		assert.deepStrictEqual(await shard.data.zRange('speedrun-season2/due', 0, -1), [ 'preserve' ]);
		const second = await sealSeason2Highways(shard, stopped);
		assert.deepStrictEqual([ second.written, second.changedRooms ], [ false, [] ]);
		assert.deepStrictEqual(await shard.data.req(highwayTerrainBackupKey, { blob: true }), before);
	}));

	test('write acknowledgement and a real main-service lock guard retrofit too', () => fresh(async ({ shard }) => {
		await legacyTerrain(shard);
		await assert.rejects(() => sealSeason2Highways(shard, { serverStopped: false }), /acknowledgement/);
		await using mutex = await Mutex.connect('main', shard.data, shard.pubsub);
		await using lock = await mutex.acquire();
		await assert.rejects(() => sealSeason2Highways(shard, stopped), /main service/);
		assert.strictEqual(await shard.data.get(highwayTerrainBackupKey, { blob: true }), null);
	}));

	test('missing, prepared, restored and partial maps refuse retrofit before backup or terrain writes', () => fresh(async ({ shard }) => {
		await assert.rejects(() => sealSeason2Highways(shard, stopped), /complete the season-2 map/);
		await legacyTerrain(shard);
		const raw = (await shard.data.get(mapStateKey))!;
		for (const state of [ 'prepared', 'restored' ]) {
			await shard.data.set(mapStateKey, JSON.stringify({ ...JSON.parse(raw), state }));
			await assert.rejects(() => sealSeason2Highways(shard, stopped), /complete the season-2 map/);
		}
		await shard.data.set(mapStateKey, raw);
		const world = await shard.loadWorld();
		world.terrain.delete('E9N9');
		await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
		await assert.rejects(() => sealSeason2Highways(shard, stopped), /incomplete/);
		assert.strictEqual(await shard.data.get(highwayTerrainBackupKey, { blob: true }), null);
	}));

	test('concurrent retrofit serializes to one write and keeps the first backup', () => fresh(async ({ shard }) => {
		await legacyTerrain(shard);
		const before = await shard.data.req('terrain', { blob: true });
		const reports = await Promise.all([ sealSeason2Highways(shard, stopped), sealSeason2Highways(shard, stopped) ]);
		assert.strictEqual(reports.filter(report => report.written).length, 1);
		assert.deepStrictEqual(await shard.data.req(highwayTerrainBackupKey, { blob: true }), before);
	}));

	test('a failed terrain write retains the original backup and allows an idempotent retry', () => fresh(async ({ shard }) => {
		await legacyTerrain(shard);
		const before = await shard.data.req('terrain', { blob: true });
		const originalSave = shard.save.bind(shard);
		shard.save = () => Promise.reject(new Error('injected backup save failure'));
		try {
			await assert.rejects(() => sealSeason2Highways(shard, stopped), /injected backup save failure/);
		} finally {
			shard.save = originalSave;
		}
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		const originalSet = shard.data.set.bind(shard.data);
		let saves = 0;
		shard.save = () => { ++saves; return originalSave(); };
		shard.data.set = (async (key: string, value: Value, options?: SetOptions) => {
			if (key === 'terrain') {
				assert.ok(saves > 0, 'persist the existing backup before retrying any terrain write');
				throw new Error('injected terrain failure');
			}
			return originalSet(key, value, options);
		}) as typeof shard.data.set;
		try {
			await assert.rejects(() => sealSeason2Highways(shard, stopped), /injected terrain failure/);
		} finally {
			shard.data.set = originalSet;
			shard.save = originalSave;
		}
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), before);
		assert.deepStrictEqual(await shard.data.req(highwayTerrainBackupKey, { blob: true }), before);
		assert.strictEqual((await sealSeason2Highways(shard, stopped)).written, true);
		assert.deepStrictEqual(await shard.data.req(highwayTerrainBackupKey, { blob: true }), before);
	}));

	test('actual creep movement cannot step onto any of the four sealed outward edges', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, stopped);
		const world = await shard.loadWorld();
		for (const [ name, xx, yy, direction ] of [
			[ 'E1N3', 1, 25, C.LEFT ], [ 'E9N3', 48, 25, C.RIGHT ],
			[ 'E3N1', 25, 48, C.BOTTOM ], [ 'E3N9', 25, 1, C.TOP ],
		] as const) {
			const record = world.terrain.get(name)!;
			const tiles = new TerrainWriter();
			const plain = { ...record, terrain: tiles, exits: packExits(tiles) };
			world.terrain.set(name, planHighwaySealing(new Map([ [ name, plain ] ]), new Set()).changes.get(name)!);
			const room = await shard.loadRoom(name);
			const creep = runOneShot(world, room, shard.time, '', () =>
				createCreep(new RoomPosition(xx, yy, name), [ C.MOVE ], 'edge-test', '100'));
			room['#insertObject'](creep);
			room['#flushObjects'](null);
			const context = new RoomProcessor(shard, world, room, shard.time);
			context.saveIntents('100', { local: {}, object: { [creep.id]: { move: [ direction ] } } });
			await context.process();
			assert.deepStrictEqual([ creep.pos.x, creep.pos.y, creep.pos.roomName ], [ xx, yy, name ]);
			// Positive control: closed highway status alone does not stop this same border crossing.
			world.terrain.set(name, plain);
			const openRoom = await shard.loadRoom(name);
			const control = runOneShot(world, openRoom, shard.time, '', () =>
				createCreep(new RoomPosition(xx, yy, name), [ C.MOVE ], 'unsealed-control', '100'));
			openRoom['#insertObject'](control);
			openRoom['#flushObjects'](null);
			const openContext = new RoomProcessor(shard, world, openRoom, shard.time);
			openContext.saveIntents('100', { local: {}, object: { [control.id]: { move: [ direction ] } } });
			await openContext.process();
			assert.strictEqual(openRoom['#objects'].some(object => object.id === control.id), false, 'unsealed control crosses the border');
			assert.ok(openRoom['#eventLog'].some(event => event.event === C.EVENT_EXIT && event.objectId === control.id));
		}
	}));

	test('the real CLI previews an older initialized map without reimporting rooms', () =>
		withLegacyCli(async run => {
			const preview = JSON.parse(await run('season2-map', '--seal-highways', '--dry-run')) as import('./map.js').HighwayReport;
			assert.strictEqual(preview.written, false);
			assert.strictEqual(preview.edges, 36);
			assert.ok(preview.changedRooms.length > 0);
		}));

	test('the real CLI retrofit persists across processes and repeated execution writes nothing', () =>
		withLegacyCli(async run => {
			const sealed = JSON.parse(await run('season2-map', '--seal-highways', '--server-stopped')) as import('./map.js').HighwayReport;
			assert.strictEqual(sealed.written, true);
			const again = JSON.parse(await run('season2-map', '--seal-highways', '--server-stopped')) as import('./map.js').HighwayReport;
			assert.deepStrictEqual([ again.written, again.changedRooms ], [ false, [] ]);
		}));
});
