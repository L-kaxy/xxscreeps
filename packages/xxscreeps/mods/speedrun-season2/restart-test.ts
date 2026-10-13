import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { acquireIntentsForRoom, userToPresenceRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardTickProcessors } from 'xxscreeps/engine/processor/shard.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { activeRunKey } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import * as Season1 from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as Race from './race.js';
import { acquireCleanup, advanceCleanup, cleanupKey, isCleanupObject, isPreservedExtractor, readCleanup, reserveCleanup } from './respawn.js';
import { resetExpiredRuns } from './restart.js';
import { editRoom, finishCleanup, landPlayer, prepareSeason, processTick, scoreable, shortSeason } from './test-fixture.js';

const fresh = simulate({});

describe('season-2 automatic restart', () => {
	test('offline full cycle records the last bracket before whole-block cleanup and allows a new run', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		await scoreable(shard, world);
		await editRoom(shard, world, 'E9N9', room => room['#insertObject'](createRoad(new RoomPosition(25, 25, room.name))));
		const old = (await shard.loadRoom('W3N3'))['#objects'].map(object => object.id);
		while (shard.time < 5) { await processTick(shard, world); }
		assert.strictEqual(await readCleanup(shard), undefined);
		await processTick(shard, world);
		const final = await shard.db.data.hGetAll(Race.scoreKey(4, '100:1'));
		assert.strictEqual(final.tick, '5');
		assert.strictEqual(final.controlPoints, '46200');
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'endedTick'), '5');
		const job = (await readCleanup(shard))!;
		assert.strictEqual(job.status, 'pending');
		assert.strictEqual(job.rooms.length, 81);
		assert.deepStrictEqual(job.run, { run: '1', room: 'E3N3', startedTick: '1' });
		await finishCleanup(shard, world);
		assert.strictEqual((await shard.loadRoom('E3N3'))['#user'], null);
		let preserved = 0;
		for (const name of job.block) {
			const room = await shard.loadRoom(name);
			assert.ok(!room['#objects'].some(isCleanupObject), name);
			preserved += room['#objects'].filter(isPreservedExtractor).length;
		}
		assert.strictEqual(preserved, 9);
		assert.deepStrictEqual((await shard.loadRoom('W3N3'))['#objects'].map(object => object.id), old);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Race.scoreKey(4, '100:1')), final);
		await landPlayer(shard, world);
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'run'), '2');
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'endedTick'), null);
	}));

	for (const duration of [ 0, -1 ]) {
		test(`${duration} disables automatic respawn without disabling scoring`, () => fresh(async ({ shard }) => {
			using settings = shortSeason(duration);
			const world = await prepareSeason(shard);
			await scoreable(shard, world);
			await runShardTickProcessors(shard, 5);
			assert.strictEqual(await readCleanup(shard), undefined);
			assert.strictEqual(await shard.db.data.hGet(Race.scoreKey(4, '100:1'), 'tick'), '5');
			assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'endedTick'), null);
		}));
	}

	test('missing duration falls back to the last configured bracket, independently of season 1', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		delete config.speedrunSeason2!.respawnAfter;
		await prepareSeason(shard);
		await runShardTickProcessors(shard, 4);
		assert.strictEqual(await readCleanup(shard), undefined);
		await runShardTickProcessors(shard, 5);
		assert.strictEqual((await readCleanup(shard))?.requestedTick, 5);
	}));

	test('low RCL still expires and does not invent a score', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await runShardTickProcessors(shard, 5);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Race.scoreKey(4, '100:1'))), []);
	}));

	test('no presence or controlled-room scratch still queues the landing and every block room', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await shard.scratch.del(userToPresenceRoomsSetKey('100'));
		await shard.scratch.del(controlledRoomsKey('100'));
		await runShardTickProcessors(shard, 5);
		assert.strictEqual((await readCleanup(shard))?.rooms.length, 81);
		assert.ok((await acquireIntentsForRoom(shard, 'E9N9')).some(value => value.intents.local.season2Respawn));
	}));

	test('repeated concurrent expiry requests use one cleanup generation', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await Race.captureDueBrackets(shard, 5);
		await Promise.all([ resetExpiredRuns(shard, 5), resetExpiredRuns(shard, 5) ]);
		const job = (await readCleanup(shard))!;
		await shard.data.zAdd(Race.racingKey, [ [ 1, '100:1' ] ]);
		await resetExpiredRuns(shard, 5);
		assert.strictEqual((await readCleanup(shard))?.id, job.id);
	}));

	test('old expiry members cannot end a newer season-2 run', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await Race.startRun(shard, '100', 'E3N3', 100);
		await shard.data.zAdd(Race.racingKey, [ [ 1, '100:1' ] ]);
		await resetExpiredRuns(shard, 5);
		assert.strictEqual(await readCleanup(shard), undefined);
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'endedTick'), null);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
	}));

	test('a stale sorted-set timestamp cannot prematurely end its matching current run', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await shard.data.zAdd(Race.racingKey, [ [ -100, '100:1' ] ]);
		await resetExpiredRuns(shard, 2);
		assert.strictEqual(await readCleanup(shard), undefined);
	}));

	test('season-1 switch survives replayed season-2 expiry with missing scratch', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await Season1.startRun(shard, '100', 'W3N3', 2);
		await shard.scratch.flushdb();
		await shard.db.data.hDel(Race.runKey('100'), [ 'endedTick' ]);
		await shard.data.zAdd(Race.racingKey, [ [ 1, '100:1' ] ]);
		await resetExpiredRuns(shard, 5);
		assert.strictEqual(await readCleanup(shard), undefined);
		assert.strictEqual(await shard.db.data.hGet(Season1.runKey('100'), 'endedTick'), null);
		assert.strictEqual((JSON.parse((await shard.db.data.get(activeRunKey('100')))!) as { namespace: string }).namespace, 'speedrun');
	}));

	test('a deleted player or out-of-block control cannot initiate a block wipe', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await shard.scratch.sAdd(controlledRoomsKey('100'), [ 'W3N3' ]);
		await Race.captureDueBrackets(shard, 5);
		await resetExpiredRuns(shard, 5);
		assert.strictEqual(await readCleanup(shard), undefined);
		await shard.scratch.del(controlledRoomsKey('100'));
		await shard.data.zAdd(Race.racingKey, [ [ 1, '100:1' ] ]);
		await shard.db.data.hDel(User.infoKey('100'), [ 'username' ]);
		await resetExpiredRuns(shard, 5);
		assert.strictEqual(await readCleanup(shard), undefined);
	}));

	for (const ownerVisible of [ false, true ]) {
		test(`a defeated player's manual respawn cannot wipe a newer player (owner visible: ${ownerVisible})`, () => fresh(async ({ shard }) => {
			using settings = shortSeason();
			const world = await prepareSeason(shard);
			await editRoom(shard, world, 'E3N3', room => {
				room['#user'] = room.controller!['#user'] = ownerVisible ? '101' : null;
			});
			await Race.startRun(shard, '101', 'E3N3', 4);
			await respawnPlayer(shard, '100');
			assert.strictEqual(await readCleanup(shard), undefined);
			assert.strictEqual(await shard.db.data.hGet(Race.runKey('101'), 'endedTick'), null);
			const intents = await acquireIntentsForRoom(shard, 'E3N3');
			assert.ok(intents.some(payload => payload.userId === '100' && payload.intents.local.unspawn !== undefined));
			assert.ok(!intents.some(payload => payload.intents.local.season2Respawn));
		}));

		test(`another player's newer landing is protected (current owner visible: ${ownerVisible})`, () => fresh(async ({ shard }) => {
			using settings = shortSeason();
			const world = await prepareSeason(shard);
			await editRoom(shard, world, 'E3N3', room => {
				room['#user'] = room.controller!['#user'] = ownerVisible ? '101' : null;
			});
			await Race.startRun(shard, '101', 'E3N3', 4);
			await Race.captureDueBrackets(shard, 5);
			await resetExpiredRuns(shard, 5);
			assert.strictEqual(await readCleanup(shard), undefined);
			assert.strictEqual(await shard.db.data.hGet(Race.runKey('101'), 'endedTick'), null);
		}));
	}

	test('pending final capture blocks cleanup, and a failed capture stays retryable', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		await scoreable(shard, world);
		{
			// Inject a storage exception before capture writes any score.
			const get = shard.db.data.hGetAll.bind(shard.db.data);
			shard.db.data.hGetAll = key => key === Race.runKey('100') ? Promise.reject(new Error('injected unavailable')) : get(key);
			try { await Race.captureDueBrackets(shard, 5); } finally { shard.db.data.hGetAll = get; }
			assert.strictEqual(await shard.data.zCard(Race.dueRunsKey), 2);
			await resetExpiredRuns(shard, 5);
			assert.strictEqual(await readCleanup(shard), undefined);
			await Race.captureDueBrackets(shard, 5);
			await resetExpiredRuns(shard, 5);
			assert.strictEqual((await readCleanup(shard))?.status, 'pending');
			assert.strictEqual(await shard.db.data.hGet(Race.scoreKey(4, '100:1'), 'controlPoints'), '46200');
		}
	}));

	test('a committed handover marker protects the next player before its async run metadata commits', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		assert.deepStrictEqual(JSON.parse((await shard.data.get(Race.landingKey))!), { user: '100', startedTick: 1 });
		await editRoom(shard, world, 'E3N3', room => { room['#user'] = room.controller!['#user'] = null; });
		await shard.data.set(Race.landingKey, JSON.stringify({ user: '101', startedTick: 4 }));
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('101'), 'run'), null);
		await Race.captureDueBrackets(shard, 5);
		await resetExpiredRuns(shard, 5);
		await respawnPlayer(shard, '100');
		assert.strictEqual(await readCleanup(shard), undefined);
		assert.ok(!(await acquireIntentsForRoom(shard, 'E3N3')).some(payload => payload.intents.local.season2Respawn));
	}));

	test('preparing reservation survives scratch loss and resumes with the same token', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		let id: string;
		{
			await using handle = await acquireCleanup(shard);
			const job = await reserveCleanup(shard, '100', [], shard.time, { run: '1', room: 'E3N3', startedTick: '1' });
			id = job.id;
		}
		await shard.scratch.flushdb();
		await advanceCleanup(shard, shard.time);
		assert.strictEqual((await readCleanup(shard))?.id, id);
		assert.strictEqual((await readCleanup(shard))?.status, 'pending');
		await finishCleanup(shard, world);
	}));

	test('a superseded preparing reservation is cancelled without stopping the new clock', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await prepareSeason(shard);
		await reserveCleanup(shard, '100', [], 1, { run: '1', room: 'E3N3', startedTick: '1' });
		await Season1.startRun(shard, '100', 'W3N3', 2);
		await advanceCleanup(shard, 2);
		assert.strictEqual((await readCleanup(shard))?.cancelled, true);
		assert.strictEqual(await shard.db.data.hGet(Season1.runKey('100'), 'endedTick'), null);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
	}));

	test('manual respawn before the final bracket never fabricates a final result', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		await scoreable(shard, world);
		await respawnPlayer(shard, '100');
		while (shard.time <= 5) { await processTick(shard, world); }
		assert.strictEqual(await shard.db.data.hGet(Race.scoreKey(4, '100:1'), 'tick'), null);
	}));

	test('completed automatic cleanup tokens cannot erase next-run buildings', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		const world = await prepareSeason(shard);
		while (shard.time <= 5) { await processTick(shard, world); }
		const job = (await readCleanup(shard))!;
		await finishCleanup(shard, world);
		await landPlayer(shard, world);
		const room = await shard.loadRoom('E3N3');
		const id = room['#objects'].find(object => object instanceof StructureSpawn)!.id;
		const context = new RoomProcessor(shard, world, room, shard.time);
		context.saveIntents('100', { local: { season2Respawn: [ [ job.id ] ] }, object: {}, internal: true });
		await context.process();
		await context.finalize(false);
		assert.ok(room['#objects'].some(object => object.id === id));
		assert.strictEqual(await shard.db.data.hGet(Race.runKey('100'), 'run'), '2');
		assert.strictEqual((JSON.parse((await shard.data.get(cleanupKey))!) as { status: string }).status, 'complete');
	}));
});
