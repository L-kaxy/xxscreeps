import type { Endpoint } from 'xxscreeps/backend/index.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { RoomIntentPayload } from 'xxscreeps/engine/processor/room.js';
import type { World } from 'xxscreeps/game/map.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { acquireIntentsForRoom, userToIntentRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runOneShot, userInfo } from 'xxscreeps/game/index.js';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { dueRunsKey, racingKey, runKey, scoreKey, startRun } from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { initializeSeason2Map } from './map.js';
import { season2MapRooms } from './original-map.js';
import { allowsInitialSpawn, spawnRoomError } from './rooms.js';
import 'xxscreeps:mods/backend';

const fresh = simulate({});
const request = (room = 'E3N3', xx = 25, yy = 25) => ({ room, name: 'Spawn1', x: xx, y: yy });

function route() {
	const routes = [ ...hooks.map('route') ].filter(info => info.path === '/api/game/place-spawn' && info.method === 'post');
	assert.strictEqual(routes.length, 1, 'the mod wraps rather than duplicates the original route');
	return routes[0]!;
}

async function api(shard: Shard, world: World, body: unknown = request(), userId: string | null = '100') {
	// Owner/reservation getters require the game's user-info cache. Scope fixture users so these
	// direct route tests exercise the real vanilla checks without leaking into another suite.
	const previous = new Map(userInfo);
	userInfo.set('100', { username: 'Player 1' });
	userInfo.set('101', { username: 'Player 2' });
	try {
		return await route().execute({
			db: shard.db, shard, backend: { world }, state: { userId }, request: { body },
		} as unknown as Parameters<Endpoint['execute']>[0]);
	} finally {
		userInfo.clear();
		for (const [ id, info ] of previous) {
			userInfo.set(id, info);
		}
	}
}

async function setup(shard: Shard) {
	await initializeSeason2Map(shard, { serverStopped: true });
	return shard.loadWorld();
}

function freeTile(world: World, room: Room) {
	const terrain = world.terrain.get(room.name)!.terrain;
	for (let yy = 2; yy < 48; ++yy) {
		for (let xx = 2; xx < 48; ++xx) {
			if ((terrain.get(xx, yy) & 1) === 0 && !room['#objects'].some(object => object.pos.x === xx && object.pos.y === yy)) {
				return { x: xx, y: yy };
			}
		}
	}
	throw new Error('Fixture has no free spawn tile');
}

async function land(shard: Shard, world: World, name: string, user = '100', queued?: boolean) {
	const room = await shard.loadRoom(name);
	const { x, y } = freeTile(world, room);
	const context = new RoomProcessor(shard, world, room, shard.time);
	if (queued) {
		for (const payload of await acquireIntentsForRoom(shard, name)) {
			context.saveIntents(payload.userId, payload.intents);
		}
	} else {
		context.saveIntents(user, { local: { placeSpawn: [ [ x, y, 'Spawn1' ] ] }, object: {}, internal: true });
	}
	await context.process();
	await context.finalize(false);
	shard.time++;
	await shard.data.set('time', shard.time);
	return shard.loadRoom(name);
}

async function assertNoSeason2Race(shard: Shard) {
	assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll('speedrun-season2/run/100')), []);
	assert.strictEqual(await shard.data.zCard('speedrun-season2/racing'), 0);
	assert.strictEqual(await shard.data.zCard('speedrun-season2/due'), 0);
}

async function assertNotQueued(shard: Shard, name = 'E3N3') {
	assert.deepStrictEqual(await acquireIntentsForRoom(shard, name), []);
	assert.strictEqual(await shard.data.hGet(User.infoKey('100'), 'lastSpawnTime'), null);
}

describe('season-2 initial spawn', () => {
	test('the shared rule restricts exactly 80 rooms and leaves other blocks alone', () => {
		assert.strictEqual(season2MapRooms.filter(name => !allowsInitialSpawn(name)).length, 80);
		assert.strictEqual(allowsInitialSpawn('E3N3'), true);
		for (const name of [ 'W3N3', 'W7N3', 'W12N1', 'E0N3', 'E10N3', 'E3N0', 'E3N10', 'E3S3', 'E03N3', 'E3N3extra', undefined ]) {
			assert.strictEqual(allowsInitialSpawn(name), true, String(name));
		}
	});

	test('the real API refuses all 80 rooms without intents, cooldown or race changes', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await startRun(shard, '100', 'W3N3', shard.time);
		await shard.db.data.hSet(scoreKey(20000, '100:1'), 'controlPoints', '123');
		const before = await shard.db.data.hGetAll(runKey('100'));
		for (const name of season2MapRooms.filter(name => name !== 'E3N3')) {
			assert.deepStrictEqual(await api(shard, world, request(name)), { error: spawnRoomError }, name);
			await assertNotQueued(shard, name);
			assert.deepStrictEqual(await shard.db.data.hGetAll(runKey('100')), before);
		}
		assert.strictEqual(await shard.data.zCard(racingKey), 1);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 2);
		assert.strictEqual(await shard.db.data.hGet(scoreKey(20000, '100:1'), 'controlPoints'), '123');
		await assertNoSeason2Race(shard);
	}));

	test('actual internal processors refuse all 80 rooms before handover or old-race cancellation', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await startRun(shard, '100', 'W3N3', shard.time);
		const before = await shard.db.data.hGetAll(runKey('100'));
		for (const name of season2MapRooms.filter(name => name !== 'E3N3')) {
			const room = await shard.loadRoom(name);
			const context = new RoomProcessor(shard, world, room, shard.time);
			context.saveIntents('100', { local: { placeSpawn: [ [ 25, 25, 'Bypass' ] ] }, object: {}, internal: true });
			await context.process();
			assert.strictEqual(room['#user'], room.controller ? null : undefined, name);
			assert.strictEqual(room['#objects'].some(object => object instanceof StructureSpawn), false, name);
			assert.deepStrictEqual(await shard.db.data.hGetAll(runKey('100')), before);
		}
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 2);
		await assertNoSeason2Race(shard);
	}));

	test('a refused internal intent does not delete pre-existing neutral buildings', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const room = await shard.loadRoom('E2N3');
		const road = runOneShot(world, room, shard.time, '', () => createRoad(new RoomPosition(25, 25, room.name)));
		room['#insertObject'](road);
		room['#flushObjects'](null);
		const context = new RoomProcessor(shard, world, room, shard.time);
		context.saveIntents('100', { local: { placeSpawn: [ [ 25, 25, 'Bypass' ] ] }, object: {}, internal: true });
		await context.process();
		assert.ok(room['#objects'].some(object => object.id === road.id));
		assert.strictEqual(room['#user'], null);
	}));

	test('E3N3 passes the original validated API then lands at the exact chosen tile', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const tile = freeTile(world, await shard.loadRoom('E3N3'));
		const body = request('E3N3', tile.x, tile.y);
		assert.deepStrictEqual(await api(shard, world, body), { ok: 1 });
		assert.ok(Number(await shard.data.hGet(User.infoKey('100'), 'lastSpawnTime')) > 0);
		const room = await land(shard, world, 'E3N3', '100', true);
		const spawns = room['#objects'].filter(object => object instanceof StructureSpawn);
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual(room['#level'], 1);
		assert.strictEqual(spawns.length, 1);
		assert.deepStrictEqual([ spawns[0]!.pos.x, spawns[0]!.pos.y, spawns[0]!.name ], [ tile.x, tile.y, 'Spawn1' ]);
		assert.ok((await shard.scratch.sMembers(userToIntentRoomsSetKey('100'))).includes('E3N3'));
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('100'))), []);
		await assertNoSeason2Race(shard);
	}));

	test('the original API still coerces numeric coordinate strings for the allowed room', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const tile = freeTile(world, await shard.loadRoom('E3N3'));
		assert.deepStrictEqual(await api(shard, world, { ...request(), x: String(tile.x), y: String(tile.y) }), { ok: 1 });
		const room = await land(shard, world, 'E3N3', '100', true);
		const spawn = room['#objects'].find(object => object instanceof StructureSpawn)!;
		assert.deepStrictEqual([ spawn.pos.x, spawn.pos.y ], [ tile.x, tile.y ]);
	}));

	test('normal room occupancy refuses a second player through both API and processor', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await land(shard, world, 'E3N3');
		await assert.rejects(api(shard, world, request(), '101'), /Room is owned/);
		assert.strictEqual(await shard.data.hGet(User.infoKey('101'), 'lastSpawnTime'), null);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
		const room = await land(shard, world, 'E3N3', '101');
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual(room['#objects'].filter(object => object instanceof StructureSpawn).length, 1);
		await assertNoSeason2Race(shard);
	}));

	test('two internal landings in one processor retain the ordinary first-owner rule', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const room = await shard.loadRoom('E3N3');
		const tile = freeTile(world, room);
		const context = new RoomProcessor(shard, world, room, shard.time);
		for (const user of [ '100', '101' ]) {
			context.saveIntents(user, { local: { placeSpawn: [ [ tile.x, tile.y, `Spawn${user}` ] ] }, object: {}, internal: true });
		}
		await context.process();
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual(room['#objects'].filter(object => object instanceof StructureSpawn).length, 1);
	}));

	test('two API requests pending in an empty room retain vanilla queuing and only one handover', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const tile = freeTile(world, await shard.loadRoom('E3N3'));
		for (const user of [ '100', '101' ]) {
			assert.deepStrictEqual(await api(shard, world, { ...request('E3N3', tile.x, tile.y), name: `Spawn${user}` }, user), { ok: 1 });
		}
		const room = await land(shard, world, 'E3N3', '100', true);
		assert.strictEqual(room['#objects'].filter(object => object instanceof StructureSpawn).length, 1);
		assert.ok(room['#user'] === '100' || room['#user'] === '101');
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('100'))), []);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('101'))), []);
		await assertNoSeason2Race(shard);
	}));

	test('non-internal player payloads cannot invoke the original internal handover', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const room = await shard.loadRoom('E3N3');
		const context = new RoomProcessor(shard, world, room, shard.time);
		const payload: RoomIntentPayload = { local: { placeSpawn: [ [ 25, 25, 'Forged' ] ] }, object: {} };
		context.saveIntents('100', payload);
		await context.process();
		assert.strictEqual(room['#user'], null);
		assert.strictEqual(room['#objects'].some(object => object instanceof StructureSpawn), false);
	}));

	test('the allowed room still refuses a reserved controller', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const room = await shard.loadRoom('E3N3');
		room['#user'] = room.controller!['#user'] = '101';
		room.controller!['#reservationEndTime'] = shard.time + 1000;
		await shard.saveRoom(room.name, shard.time, room);
		await assert.rejects(api(shard, world), /Room is owned/);
		await assertNotQueued(shard);
	}));

	for (const presence of [ 'W3N3', 'E8N8', 'W12N1' ]) {
		test(`presence in ${presence} still prevents a new E3N3 landing`, () => fresh(async ({ shard }) => {
			const world = await setup(shard);
			await shard.scratch.sAdd(userToIntentRoomsSetKey('100'), [ presence ]);
			await assert.rejects(api(shard, world), /User has presence/);
			await assertNotQueued(shard);
		}));
	}

	test('the original respawn cooldown still refuses E3N3 without queuing an intent', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const settings = config.game.respawnTimeout;
		config.game.respawnTimeout = 1;
		const last = String(Date.now());
		await shard.data.hSet(User.infoKey('100'), 'lastSpawnTime', last);
		try {
			await assert.rejects(api(shard, world), /Too soon after last respawn/);
			assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
			assert.strictEqual(await shard.data.hGet(User.infoKey('100'), 'lastSpawnTime'), last);
		} finally {
			config.game.respawnTimeout = settings;
		}
	}));

	for (const [ xx, yy ] of [ [ -1, 25 ], [ 50, 25 ], [ 0, 0 ] ]) {
		test(`the allowed room keeps original invalid-tile checks at ${xx},${yy}`, () => fresh(async ({ shard }) => {
			const world = await setup(shard);
			await assert.rejects(api(shard, world, request('E3N3', xx, yy)));
			await assertNotQueued(shard);
			assert.strictEqual((await shard.loadRoom('E3N3'))['#user'], null);
		}));
	}

	test('original terrain-wall placement checks remain active in E3N3', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const terrain = world.terrain.get('E3N3')!.terrain;
		let tile: { x: number; y: number } | undefined;
		for (let yy = 2; yy < 48 && !tile; ++yy) {
			for (let xx = 2; xx < 48 && !tile; ++xx) {
				if ((terrain.get(xx, yy) & 1) !== 0) {
					tile = { x: xx, y: yy };
				}
			}
		}
		assert.ok(tile);
		await assert.rejects(api(shard, world, request('E3N3', tile.x, tile.y)), /Invalid intent/);
		await assertNotQueued(shard);
	}));

	test('invalid payloads and unauthenticated calls retain the original route behavior', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		for (const body of [ null, {}, { room: 'E3N3' }, { ...request(), x: 'not-a-number' } ]) {
			assert.deepStrictEqual(await api(shard, world, body), { error: 'invalid' });
		}
		assert.strictEqual(await api(shard, world, request('E2N3'), null), undefined);
		await assertNotQueued(shard);
	}));

	test('outside the forbidden rooms the original schema still precedes authentication access', async () => {
		const state = Object.defineProperty({}, 'userId', {
			get() { throw new Error('Unauthorized'); },
		});
		const context = { state, request: { body: { room: 'E3N3' } } } as unknown as Parameters<Endpoint['execute']>[0];
		assert.deepStrictEqual(route().execute(context), { error: 'invalid' });
		context.request.body = request();
		await assert.rejects(async () => await route().execute(context), /Unauthorized/);
	});

	test('a rejected room can immediately retry the allowed room without consuming cooldown', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		assert.deepStrictEqual(await api(shard, world, request('E9N9')), { error: spawnRoomError });
		const tile = freeTile(world, await shard.loadRoom('E3N3'));
		assert.deepStrictEqual(await api(shard, world, request('E3N3', tile.x, tile.y)), { ok: 1 });
		assert.strictEqual((await land(shard, world, 'E3N3', '100', true))['#user'], '100');
	}));

	test('season-1 API landing still starts its existing race and due queue', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const tile = freeTile(world, await shard.loadRoom('W3N3'));
		assert.deepStrictEqual(await api(shard, world, request('W3N3', tile.x, tile.y)), { ok: 1 });
		const room = await land(shard, world, 'W3N3', '100', true);
		assert.strictEqual(room['#user'], '100');
		assert.strictEqual((await shard.db.data.hGetAll(runKey('100'))).room, 'W3N3');
		assert.strictEqual(await shard.data.zCard(racingKey), 1);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 2);
		await assertNoSeason2Race(shard);
	}));

	test('other sectors keep their vanilla API and processor landing', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		const room = await shard.loadRoom('W12N1');
		runOneShot(world, room, shard.time, '', () => {
			const controller = createRoomObject(new StructureController(), new RoomPosition(33, 32, room.name));
			room['#insertObject'](controller);
		});
		room['#flushObjects'](null);
		room['#user'] = null;
		room['#level'] = 0;
		await shard.saveRoom(room.name, shard.time, room);
		const tile = freeTile(world, room);
		assert.deepStrictEqual(await api(shard, world, request(room.name, tile.x, tile.y)), { ok: 1 });
		assert.strictEqual((await land(shard, world, room.name, '100', true))['#user'], '100');
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('100'))), []);
		await assertNoSeason2Race(shard);
	}));

	test('a valid E3N3 handover preserves the existing outside-landing cancellation of season 1', () => fresh(async ({ shard }) => {
		const world = await setup(shard);
		await startRun(shard, '100', 'W3N3', shard.time);
		await land(shard, world, 'E3N3');
		const run = await shard.db.data.hGetAll(runKey('100'));
		assert.strictEqual(run.room, 'W3N3');
		assert.ok(run.endedTick !== undefined);
		assert.strictEqual(await shard.data.zCard(racingKey), 0);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 0);
		await assertNoSeason2Race(shard);
	}));
});
