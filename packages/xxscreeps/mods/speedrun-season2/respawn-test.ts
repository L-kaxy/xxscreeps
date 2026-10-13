import type { Endpoint } from 'xxscreeps/backend/index.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { World } from 'xxscreeps/game/map.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { acquireIntentsForRoom, sleepingRoomsKey, updateUserRoomRelationships } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardTickProcessors } from 'xxscreeps/engine/processor/shard.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { flushUsers } from 'xxscreeps/game/room/room.js';
import { create as createSite } from 'xxscreeps/mods/classic/construction/construction-site.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { create as createWall } from 'xxscreeps/mods/classic/defense/wall.js';
import { create as createExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { create as createContainer } from 'xxscreeps/mods/classic/resource/container.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Ruin, createRuin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { Structure } from 'xxscreeps/mods/classic/structure/structure.js';
import { create as createPowerBank } from 'xxscreeps/mods/modern/powerbank/powerbank.js';
import { create as createPortal } from 'xxscreeps/mods/portal/portal.js';
import * as Season1 from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializeSeason2Map } from './map.js';
import * as Season2 from './race.js';
import {
	advanceCleanup, blocksSpawn, cleanupKey, cleanupSpawnError,
	isCleanRoom, isCleanupObject, isPreservedExtractor, readCleanup,
} from './respawn.js';
import 'xxscreeps:mods/backend';

const fresh = simulate({});
const binary = fileURLToPath(new URL('../../../xxscreeps.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../test/data/shard.json', import.meta.url));
const command = promisify(execFile);

async function edit(shard: Shard, world: World, name: string, body: (room: Room) => void) {
	const room = await shard.loadRoom(name);
	runOneShot(world, room, shard.time, '', () => body(room));
	room['#flushObjects'](null);
	const previous = flushUsers(room);
	await shard.saveRoom(name, shard.time, room);
	await shard.copyRoomFromPreviousTick(name, shard.time + 1);
	await updateUserRoomRelationships(shard, room, previous);
}

async function land(shard: Shard, world: World, name = 'E3N3', user = '100') {
	const room = await shard.loadRoom(name);
	const context = new RoomProcessor(shard, world, room, shard.time);
	context.saveIntents(user, { local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] }, object: {}, internal: true });
	await context.process();
	await context.finalize(false);
	++shard.time;
	await shard.data.set('time', shard.time);
}

async function setup(shard: Shard) {
	await initializeSeason2Map(shard, { serverStopped: true });
	const world = await shard.loadWorld();
	await land(shard, world);
	return world;
}

/** Actual queues and room processors, all saved at the same next tick, then the real main hook. */
async function processCleanup(shard: Shard, world: World) {
	const job = await readCleanup(shard);
	assert.ok(job);
	for (const name of job.rooms) {
		const room = await shard.loadRoom(name);
		const context = new RoomProcessor(shard, world, room, shard.time);
		for (const payload of await acquireIntentsForRoom(shard, name)) {
			context.saveIntents(payload.userId, payload.intents);
		}
		await context.process();
		await context.finalize(false);
	}
	await runShardTickProcessors(shard, shard.time);
	if (shard.time <= job.requestedTick) {
		assert.notStrictEqual((await readCleanup(shard))?.status, 'complete', 'request tick cannot open the gate');
	} else if ((await readCleanup(shard))?.status === 'complete') {
		// Sleeping-room finalize copies the saved next state into BOTH buffers. It may already
		// be verifiably current; only that persisted state (never an in-memory mutation) can unlock.
		for (const name of job.rooms) {
			assert.ok(isCleanRoom(await shard.loadRoom(name), job), `stored current buffer: ${name}`);
		}
	}
	++shard.time;
	await shard.data.set('time', shard.time);
	await advanceCleanup(shard, shard.time);
}

function api(shard: Shard, world: World, routePath: string, body: unknown, user = '100') {
	const route = [ ...hooks.map('route') ].find(info => info.path === routePath && info.method === 'post');
	assert.ok(route);
	return route.execute({
		db: shard.db, shard, backend: { world }, state: { userId: user }, request: { body },
	} as unknown as Parameters<Endpoint['execute']>[0]);
}

describe('season-2 respawn cleanup', () => {
	test('manual API requests the whole block, ends only the new clock and preserves historical scores', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await shard.db.data.hSet(Season1.scoreKey(20000, '100:7'), 'controlPoints', '123');
		await shard.db.data.hSet(Season2.scoreKey(20000, '100:1'), 'controlPoints', '456');
		assert.deepStrictEqual(await api(shard, world, '/api/user/respawn', {}), { ok: 1 });
		const job = await readCleanup(shard);
		assert.ok(job);
		assert.strictEqual(job.rooms.length, 81);
		assert.strictEqual(job.block.length, 81);
		assert.strictEqual(job.status, 'pending');
		assert.strictEqual(await shard.data.zCard(Season2.racingKey), 0);
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 0);
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'endedTick'), String(shard.time));
		await processCleanup(shard, world);
		assert.strictEqual((await readCleanup(shard))?.status, 'complete');
		assert.strictEqual(await shard.db.data.hGet(Season1.scoreKey(20000, '100:7'), 'controlPoints'), '123');
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(20000, '100:1'), 'controlPoints'), '456');
	}));

	test('clears all owners, neutral buildings, sites and ruins without touching natural objects or terrain', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const terrainBefore = Uint8Array.from(world.terrainBlob);
		const natural = new Map<string, string[]>();
		for (const name of world.terrain.keys()) {
			if (name.startsWith('E')) {
				const room = await shard.loadRoom(name);
				natural.set(name, room['#objects'].filter(object =>
					!isCleanupObject(object) && object['#user'] !== '100').map(object => object.id));
			}
		}
		await edit(shard, world, 'E2N2', room => {
			const pos = new RoomPosition(25, 25, room.name);
			room['#insertObject'](createRoad(pos));
			room['#insertObject'](createContainer(new RoomPosition(26, 25, room.name)));
			room['#insertObject'](createWall(new RoomPosition(27, 25, room.name)));
			room['#insertObject'](createSpawn(new RoomPosition(28, 25, room.name), '101', 'Other'));
			room['#insertObject'](createExtractor(new RoomPosition(29, 25, room.name), null));
			room['#insertObject'](createSite(new RoomPosition(30, 25, room.name), C.STRUCTURE_EXTENSION, '101', 200));
		});
		const settings = config.speedrun!;
		try {
			config.speedrun = { ...settings, ruins: true };
			await edit(shard, world, 'E2N3', room => {
				room['#insertObject'](createRuin(createSpawn(new RoomPosition(25, 25, room.name), '101', 'Gone')));
			});
			await respawnPlayer(shard, '100');
			await processCleanup(shard, world);
			for (const name of (await readCleanup(shard))!.block) {
				const room = await shard.loadRoom(name);
				assert.ok(!room['#objects'].some(isCleanupObject), name);
				assert.ok(!room['#objects'].some(object => object instanceof Ruin), name);
				for (const id of natural.get(name) ?? []) {
					assert.ok(room['#objects'].some(object => object.id === id), `${name}:${id} is preserved`);
				}
			}
			assert.deepStrictEqual((await shard.loadWorld()).terrainBlob, terrainBefore);
		} finally {
			config.speedrun = settings;
		}
	}));

	test('preserves extractors in all nine central rooms but removes extractor sites and noncentral extractors', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const preserved: string[] = [];
		for (let xx = 4; xx <= 6; ++xx) {
			for (let yy = 4; yy <= 6; ++yy) {
				await edit(shard, world, `E${xx}N${yy}`, room => {
					for (const extractor of room['#objects'].filter(isPreservedExtractor)) {
						preserved.push(extractor.id);
					}
					const mine = createExtractor(new RoomPosition(25, 25, room.name), '100');
					preserved.push(mine.id);
					room['#insertObject'](mine);
					room['#insertObject'](createSite(new RoomPosition(26, 25, room.name), C.STRUCTURE_EXTRACTOR, '100', 200));
				});
			}
		}
		assert.strictEqual(preserved.length, 18, 'nine original and nine fixture extractors');
		await edit(shard, world, 'E3N3', room => {
			room['#insertObject'](createExtractor(new RoomPosition(26, 25, room.name), '100'));
		});
		await respawnPlayer(shard, '100');
		await processCleanup(shard, world);
		const found: string[] = [];
		for (const name of (await readCleanup(shard))!.block) {
			const room = await shard.loadRoom(name);
			for (const object of room['#objects'].filter(isPreservedExtractor)) {
				found.push(object.id);
				assert.strictEqual(object['#user'], null);
			}
			assert.ok(!room['#objects'].some(isCleanupObject), name);
		}
		assert.deepStrictEqual(found.sort(), preserved.sort());
	}));

	test('covers a sleeping room with no player presence and keeps old neutral buildings untouched', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await edit(shard, world, 'E9N9', room => room['#insertObject'](createRoad(new RoomPosition(25, 25, room.name))));
		await shard.scratch.zAdd(sleepingRoomsKey, [ [ Infinity, 'E9N9' ] ]);
		await edit(shard, world, 'W2N2', room => room['#insertObject'](createRoad(new RoomPosition(25, 25, room.name))));
		const before = (await shard.loadRoom('W2N2'))['#objects'].map(object => object.id);
		await respawnPlayer(shard, '100');
		assert.ok((await readCleanup(shard))!.rooms.includes('E9N9'));
		assert.notStrictEqual(await shard.scratch.zScore(sleepingRoomsKey, 'E9N9'), Infinity);
		await processCleanup(shard, world);
		assert.ok(!(await shard.loadRoom('E9N9'))['#objects'].some(isCleanupObject));
		assert.deepStrictEqual((await shard.loadRoom('W2N2'))['#objects'].map(object => object.id), before);
	}));

	test('global handover still removes the player outside the block but not other players', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await edit(shard, world, 'W12N1', room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, room.name), [ C.MOVE ], 'Outside', '100'));
			room['#insertObject'](createCreep(new RoomPosition(26, 25, room.name), [ C.MOVE ], 'Other', '101'));
		});
		await respawnPlayer(shard, '100');
		assert.ok((await readCleanup(shard))!.rooms.includes('W12N1'));
		await processCleanup(shard, world);
		assert.ok(!(await shard.loadRoom('W12N1'))['#objects'].some(object => object['#user'] === '100'));
		assert.ok((await shard.loadRoom('W12N1'))['#objects'].some(object => object['#user'] === '101'));
	}));

	test('pending cleanup rejects HTTP and internal landings without cooldown or new runs', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		const before = await shard.db.data.hGetAll(Season2.runKey('100'));
		for (const [ user, name ] of [ [ '100', 'E3N3' ], [ '101', 'E3N3' ], [ '100', 'W3N3' ] ]) {
			assert.deepStrictEqual(await api(shard, world, '/api/game/place-spawn', { room: name, name: 'New', x: 25, y: 25 }, user),
				{ error: cleanupSpawnError });
			assert.strictEqual(await shard.data.hGet(User.infoKey(user!), 'lastSpawnTime'), null);
		}
		const job = (await readCleanup(shard))!;
		assert.strictEqual(blocksSpawn(job, '101', 'W3N3'), false);
		await land(shard, world, 'W3N3');
		assert.strictEqual((await shard.loadRoom('W3N3'))['#user'], null);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season2.runKey('100')), before);
	}));

	test('repeated respawn and delayed old intents cannot delete next-run buildings', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		const original = (await readCleanup(shard))!;
		await respawnPlayer(shard, '100');
		assert.strictEqual((await readCleanup(shard))!.id, original.id);
		await processCleanup(shard, world);
		await land(shard, world);
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'run'), '2');
		const room = await shard.loadRoom('E3N3');
		const before = room['#objects'].filter(object => object instanceof Structure).map(object => object.id);
		const context = new RoomProcessor(shard, world, room, shard.time);
		context.saveIntents('100', { local: { season2Respawn: [ [ original.id ] ] }, object: {}, internal: true });
		await context.process();
		await context.finalize(false);
		assert.deepStrictEqual(room['#objects'].filter(object => object instanceof Structure).map(object => object.id), before);
		assert.strictEqual(room['#user'], '100');
	}));

	test('multiple users in one landing batch retain their identity and do not acquire the gate twice', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, { serverStopped: true });
		const world = await shard.loadWorld();
		const room = await shard.loadRoom('E3N3');
		const context = new RoomProcessor(shard, world, room, shard.time);
		for (const user of [ '100', '101' ]) {
			context.saveIntents(user, { local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] }, object: {}, internal: true });
		}
		await context.process();
		await context.finalize(false);
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'run'), '1');
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('101'), 'run'), null);
	}));

	test('concurrent room processors cannot open the gate before all stored target rooms are clean', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await edit(shard, world, 'E9N8', room => room['#insertObject'](createRoad(new RoomPosition(25, 25, room.name))));
		await respawnPlayer(shard, '100');
		const contexts = await Promise.all([ 'E3N3', 'E2N2', 'E4N4', 'E9N9' ].map(async name => {
			const room = await shard.loadRoom(name);
			const context = new RoomProcessor(shard, world, room, shard.time);
			for (const payload of await acquireIntentsForRoom(shard, name)) {
				context.saveIntents(payload.userId, payload.intents);
			}
			return context;
		}));
		await Promise.all(contexts.map(context => context.process()));
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending', 'in-memory mutations are not saved yet');
		await Promise.all(contexts.map(context => context.finalize(false)));
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
		++shard.time;
		await shard.data.set('time', shard.time);
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending', 'remote road is still stored');
		await processCleanup(shard, world);
		assert.strictEqual((await readCleanup(shard))?.status, 'complete');
	}));

	test('another user respawning cannot replace the pending cleanup generation', () => fresh(async ({ shard }) => {
		await setup(shard);
		await respawnPlayer(shard, '100');
		const job = (await readCleanup(shard))!;
		await respawnPlayer(shard, '101', [ 'W2N2' ]);
		assert.deepStrictEqual(await readCleanup(shard), job);
		assert.ok((await acquireIntentsForRoom(shard, 'W2N2')).some(payload =>
			payload.userId === '101' && payload.intents.local.unspawn !== undefined));
	}));

	test('lost scratch queues recover from the persistent job and legacy acknowledgments cannot open the gate', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		const job = (await readCleanup(shard))!;
		await shard.scratch.flushdb();
		await shard.data.set(cleanupKey, JSON.stringify({ ...job, status: 'preparing' }));
		for (const name of job.rooms) {
			await shard.data.hSet(`speedrun-season2/cleanup-acks/${job.id}`, name, String(shard.time));
		}
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending', 'saved spawn has not been removed');
		await processCleanup(shard, world);
		assert.strictEqual((await readCleanup(shard))?.status, 'complete');
		assert.strictEqual((await shard.loadRoom('E3N3'))['#user'], null);
	}));

	test('in-memory cleanup and a saved next buffer both keep the gate closed until current-buffer verification', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		// Move past the request tick without processing its queue, preserving the dirty landing.
		await shard.saveRoom('E3N3', shard.time + 1, await shard.loadRoom('E3N3'));
		++shard.time;
		await shard.data.set('time', shard.time);
		const room = await shard.loadRoom('E3N3');
		const context = new RoomProcessor(shard, world, room, shard.time);
		for (const payload of await acquireIntentsForRoom(shard, room.name)) {
			context.saveIntents(payload.userId, payload.intents);
		}
		await context.process();
		assert.strictEqual(room['#user'], null);
		assert.strictEqual((await shard.loadRoom(room.name))['#user'], '100', 'only in memory so far');
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
		context.wakeAt(context.nextTime);
		await context.finalize(false);
		assert.strictEqual((await shard.loadRoom(room.name))['#user'], '100', 'active room has not copied its next buffer');
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending', 'next buffer is not current yet');
		++shard.time;
		await shard.data.set('time', shard.time);
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'complete');
	}));

	test('uncleared persisted targets after tick advancement remain blocked without acknowledgments', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		const job = (await readCleanup(shard))!;
		await shard.scratch.flushdb();
		const room = await shard.loadRoom('E3N3');
		await shard.saveRoom(room.name, shard.time + 1, room);
		++shard.time;
		await shard.data.set('time', shard.time);
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
		assert.deepStrictEqual(await api(shard, world, '/api/game/place-spawn', { room: 'E3N3', name: 'New', x: 25, y: 25 }),
			{ error: cleanupSpawnError });
		assert.ok((await acquireIntentsForRoom(shard, room.name)).some(payload =>
			payload.intents.local.season2Respawn?.some(([ id ]) => id === job.id)));
		await advanceCleanup(shard, shard.time);
		await processCleanup(shard, world);
		assert.strictEqual((await readCleanup(shard))?.status, 'complete');
	}));

	test('world portals and power banks are not artificial buildings', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const preserved: string[] = [];
		await edit(shard, world, 'E2N2', room => {
			const bank = createPowerBank(new RoomPosition(25, 25, room.name), 1000);
			const portal = createPortal(new RoomPosition(26, 25, room.name), new RoomPosition(25, 25, 'W12N1'));
			for (const object of [ bank, portal ]) {
				preserved.push(object.id);
				room['#insertObject'](object);
				assert.strictEqual(isCleanupObject(object), false);
			}
		});
		await respawnPlayer(shard, '100');
		await processCleanup(shard, world);
		const room = await shard.loadRoom('E2N2');
		for (const id of preserved) {
			assert.ok(room['#objects'].some(object => object.id === id));
		}
	}));

	test('empty scoring brackets do not disable cleanup of an owned season-2 room', () => fresh(async ({ shard }) => {
		const settings = config.speedrunSeason2!;
		try {
			config.speedrunSeason2 = { ...settings, raceBrackets: [] };
			const world = await setup(shard);
			assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'run'), null);
			await respawnPlayer(shard, '100');
			assert.strictEqual((await readCleanup(shard))?.rooms.length, 81);
			await processCleanup(shard, world);
			assert.strictEqual((await shard.loadRoom('E3N3'))['#user'], null);
		} finally {
			config.speedrunSeason2 = settings;
		}
	}));

	test('disabled cleanup keeps neutral buildings but still performs global exit and ends the run', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await edit(shard, world, 'E3N3', room => room['#insertObject'](createRoad(new RoomPosition(26, 25, room.name))));
		const settings = config.speedrunSeason2!;
		try {
			config.speedrunSeason2 = { ...settings, respawnCleanup: false };
			await respawnPlayer(shard, '100');
			assert.strictEqual((await readCleanup(shard))?.cleanup, false);
			await processCleanup(shard, world);
			const room = await shard.loadRoom('E3N3');
			assert.strictEqual(room['#user'], null);
			assert.ok(room['#objects'].some(object => object instanceof Structure && object.structureType === C.STRUCTURE_ROAD));
			assert.strictEqual(await shard.data.zCard(Season2.racingKey), 0);
		} finally {
			config.speedrunSeason2 = settings;
		}
	}));

	test('old-season respawn does not create a new-season cleanup job', () => fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, { serverStopped: true });
		const world = await shard.loadWorld();
		await land(shard, world, 'W3N3');
		await respawnPlayer(shard, '100');
		assert.strictEqual(await readCleanup(shard), undefined);
		assert.ok((await acquireIntentsForRoom(shard, 'W3N3')).some(payload => payload.intents.local.unspawn));
		assert.strictEqual(await shard.data.zCard(Season1.racingKey), 1, 'old lifecycle is unchanged');
	}));

	test('ordinary player-supplied cleanup intents are ignored', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await respawnPlayer(shard, '100');
		const job = (await readCleanup(shard))!;
		const room = await shard.loadRoom('E3N3');
		const context = new RoomProcessor(shard, world, room, shard.time);
		context.saveIntents('100', { local: { season2Respawn: [ [ job.id ] ] }, object: {} });
		await context.process();
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
	}));

	test('a new process resumes a persisted cleanup without reimporting terrain or resetting its generation', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xs2c-'));
		try {
			await fs.writeFile(path.join(directory, '.screepsrc.yaml'), JSON.stringify({
				mods: [ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun', 'xxscreeps/mods/speedrun-season2' ],
			}));
			const imports = `
				const {config}=await import('xxscreeps/config/index.js');
				const {Database,Shard}=await import('xxscreeps/engine/db/index.js');
				await import('xxscreeps:mods/processor');
				const cleanup=await import('xxscreeps/mods/speedrun-season2/respawn.js');
				await using db=await Database.connect();await using shard=await Shard.connect(db,config.shards[0].name);`;
			const run = async (source: string) => {
				const { stdout } = await command(process.execPath, [ '--experimental-vm-modules', binary, 'eval', '-e', source ],
					{ cwd: directory, timeout: 8000, maxBuffer: 2 ** 20 });
				return JSON.parse(stdout) as { id: string; status: string; rooms: number; queued?: boolean };
			};
			const before = await run(`(async()=>{${imports}
				const {readFile}=await import('node:fs/promises');
				const {importPayload,seedShard}=await import('xxscreeps/scripts/payload.js');
				await seedShard(shard,importPayload(JSON.parse(await readFile(${JSON.stringify(fixture)},'utf8'))));
				const {initializeSeason2Map}=await import('xxscreeps/mods/speedrun-season2/map.js');
				await initializeSeason2Map(shard,{serverStopped:true});
				const race=await import('xxscreeps/mods/speedrun-season2/race.js');
				await race.startRun(shard,'100','E3N3',0);
				const {respawnPlayer}=await import('xxscreeps/mods/classic/spawn/model.js');
				await respawnPlayer(shard,'100');await shard.scratch.flushdb();
				await shard.save();await db.save();
				const job=await cleanup.readCleanup(shard);
				return JSON.stringify({id:job.id,status:job.status,rooms:job.rooms.length});
			})()`);
			const after = await run(`(async()=>{${imports}
				await cleanup.advanceCleanup(shard,shard.time);
				const {acquireIntentsForRoom}=await import('xxscreeps/engine/processor/model.js');
				const queue=await acquireIntentsForRoom(shard,'E9N9');
				const job=await cleanup.readCleanup(shard);await shard.save();await db.save();
				return JSON.stringify({id:job.id,status:job.status,rooms:job.rooms.length,
					queued:queue.some(p=>p.intents.local.season2Respawn?.some(args=>args[0]===job.id))});
			})()`);
			assert.deepStrictEqual(after, { ...before, queued: true });
			assert.strictEqual(after.rooms, 81);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
