import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { World } from 'xxscreeps/game/map.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { acquireIntentsForRoom } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardTickProcessors } from 'xxscreeps/engine/processor/shard.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import * as Season1 from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { initializeSeason2Map } from './map.js';
import * as Season2 from './race.js';

const fresh = simulate({});
const command = promisify(execFile);
const binary = fileURLToPath(new URL('../../../xxscreeps.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../test/data/shard.json', import.meta.url));

function shortBrackets() {
	const settings = config.speedrunSeason2!;
	const previous = { ...settings };
	settings.raceBrackets = [ 2, 4 ];
	// This suite isolates scoring; full timed respawn is covered in restart-test.
	settings.respawnAfter = 0;
	return { [Symbol.dispose]() {
		Object.assign(settings, previous);
		if (previous.raceBrackets === undefined) {
			delete settings.raceBrackets;
		}
		if (previous.respawnAfter === undefined) {
			delete settings.respawnAfter;
		}
	} };
}

async function setup(shard: Shard) {
	await initializeSeason2Map(shard, { serverStopped: true });
	return shard.loadWorld();
}

async function own(shard: Shard, user = '100', level = 3, progress = 1000, name = 'E3N3') {
	const room = await shard.loadRoom(name);
	room['#user'] = room.controller!['#user'] = user;
	room['#level'] = level;
	room.controller!['#progress'] = progress;
	room.controller!['#downgradeTime'] = 100000;
	await shard.saveRoom(name, shard.time, room);
	return room;
}

async function score(shard: Shard, user = '100', level = 3, progress = 1000, time = 0) {
	await own(shard, user, level, progress);
	const run = await Season2.startRun(shard, user, 'E3N3', time);
	assert.ok(run !== undefined);
	assert.strictEqual(await Season2.captureBracket(shard, `${user}:${run}:2`, time + 2), `${user}:${run}`);
	return run;
}

async function noScore(shard: Shard, run = '100:1', bracket = 2) {
	assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Season2.scoreKey(bracket, run))), []);
	assert.strictEqual(await shard.db.data.zCard(Season2.rankKey(bracket)), 0);
	assert.strictEqual(await shard.db.data.zCard(Season2.bestKey(bracket)), 0);
}

async function processRoom(shard: Shard, world: World, land = false) {
	const room = await shard.loadRoom('E3N3');
	const context = new RoomProcessor(shard, world, room, shard.time);
	if (land) {
		const terrain = world.terrain.get(room.name)!.terrain;
		let tile: [ number, number ] | undefined;
		for (let yy = 2; yy < 48 && !tile; ++yy) {
			for (let xx = 2; xx < 48; ++xx) {
				if (!(terrain.get(xx, yy) & 1) && !room['#objects'].some(object => object.pos.x === xx && object.pos.y === yy)) {
					tile = [ xx, yy ];
					break;
				}
			}
		}
		assert.ok(tile);
		context.saveIntents('100', { local: { placeSpawn: [ [ ...tile, 'Spawn1' ] ] }, object: {}, internal: true });
	}
	await context.process();
	await context.finalize(false);
	++shard.time;
	await shard.data.set('time', shard.time);
	await runShardTickProcessors(shard, shard.time);
	return shard.loadRoom(room.name);
}

describe('season-2 scores', () => {
	test('all results, ranking and history keys use only the new namespace', () => {
		assert.deepStrictEqual([
			Season2.scoreKey(2, '100:1'), Season2.rankKey(2), Season2.bestKey(2),
			Season2.playerRunsKey(2, '100'), Season2.playerBracketsKey('100'),
		], [
			'speedrun-season2/score/2/100:1', 'speedrun-season2/rank/2', 'speedrun-season2/best/2',
			'speedrun-season2/runs/2/100', 'speedrun-season2/brackets/100',
		]);
		assert.strictEqual(Season2.controlPointsOf(3, 1000), 46200);
		assert.strictEqual(Season2.runIdOf('100', 1), '100:1');
		assert.strictEqual('resetExpiredRuns' in Season2, false);
	});

	test('empty result readers return no legacy data', () => fresh(async ({ shard }) => {
		await shard.db.data.zAdd(Season1.bestKey(2), [ [ 999, '100' ] ]);
		assert.deepStrictEqual(await Season2.readLeaderboard(shard, 2, 0, 10), { count: 0, list: [] });
		assert.deepStrictEqual(await Season2.readPlayerRecords(shard, '100', [ 2, 4 ]), []);
		assert.deepStrictEqual(await Season2.readPlayerBrackets(shard, '100'), []);
	}));

	test('real handover and room ticks score an offline player at both short brackets without respawn', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		const world = await setup(shard);
		await processRoom(shard, world, true);
		await own(shard);
		await processRoom(shard, world);
		await noScore(shard);
		await processRoom(shard, world);
		const first = await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1'));
		assert.strictEqual(first.startedTick, '1');
		assert.strictEqual(first.tick, '3');
		assert.strictEqual(first.elapsed, '2');
		assert.strictEqual(first.controlPoints, '46200');
		assert.deepStrictEqual(await shard.data.zRange(Season2.dueRunsKey, 0, -1), [ '100:1:4' ]);
		await own(shard, '100', 4, 200);
		await processRoom(shard, world);
		const room = await processRoom(shard, world);
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(4, '100:1'), 'controlPoints'), '180400');
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(4, '100:1'), 'tick'), '5');
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 0);
		assert.strictEqual(await shard.data.zCard(Season2.racingKey), 1);
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'endedTick'), null);
		assert.ok(room['#objects'].some(object => object instanceof StructureSpawn));
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Season1.scoreKey(2, '100:1'))), []);
	}));

	test('captured fields and all result indexes agree', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await shard.db.data.hSet(User.infoKey('100'), 'gcl', '1234');
		await score(shard);
		const fields = await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1'));
		assert.ok(Number(fields.at) > 0);
		const { at: ignored, ...record } = fields;
		assert.deepStrictEqual(record, {
			bracket: '2', controlPoints: '46200', elapsed: '2', gcl: '1234',
			level: '3', progress: '1000', progressTotal: '135000', room: 'E3N3', run: '1',
			runId: '100:1', startedTick: '0', tick: '2', user: '100', username: 'Player 1',
		});
		assert.strictEqual(await shard.db.data.zScore(Season2.rankKey(2), '100:1'), 46200);
		assert.strictEqual(await shard.db.data.zScore(Season2.bestKey(2), '100'), 46200);
		assert.strictEqual(await shard.db.data.zScore(Season2.playerRunsKey(2, '100'), '1'), 46200);
		assert.strictEqual(await shard.db.data.hGet(Season2.playerBracketsKey('100'), '2'), '46200');
		assert.deepStrictEqual(await Season2.readPlayerBrackets(shard, '100'), [ { bracket: 2, score: 46200 } ]);
		assert.strictEqual((await Season2.readPlayerRecords(shard, '100', [ 2 ]))[0]!.record.gcl, 1234);
	}));

	test('the old queue cannot consume a new bracket and new scoring does not change old tables', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season1.startRun(shard, '101', 'W3N3', 0);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await shard.db.data.hSet(Season1.scoreKey(2, '100:1'), 'controlPoints', '999');
		await shard.db.data.zAdd(Season1.bestKey(2), [ [ 999, '100' ] ]);
		const oldDue = await shard.data.zRangeWithScores(Season1.dueRunsKey, 0, -1);
		await Season1.captureDueBrackets(shard, 2);
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 2);
		await noScore(shard);
		await Season2.captureDueBrackets(shard, 2);
		assert.deepStrictEqual(await shard.data.zRangeWithScores(Season1.dueRunsKey, 0, -1), oldDue);
		assert.strictEqual(await shard.db.data.hGet(Season1.scoreKey(2, '100:1'), 'controlPoints'), '999');
		assert.strictEqual(await shard.db.data.zScore(Season1.bestKey(2), '100'), 999);
		assert.strictEqual(await shard.db.data.zCard(Season1.rankKey(2)), 0);
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(2, '100:1'), 'controlPoints'), '46200');
	}));

	for (const level of [ 0, 1 ]) {
		test(`RCL ${level} consumes its due entry without a result or late retry`, () => fresh(async ({ shard }) => {
			using settings = shortBrackets();
			await setup(shard);
			await own(shard, '100', level);
			await Season2.startRun(shard, '100', 'E3N3', 0);
			await Season2.captureDueBrackets(shard, 2);
			await noScore(shard);
			await own(shard, '100', 3);
			await Season2.captureDueBrackets(shard, 3);
			await noScore(shard);
			assert.deepStrictEqual(await shard.data.zRange(Season2.dueRunsKey, 0, -1), [ '100:1:4' ]);
			assert.strictEqual(await shard.data.zCard(Season2.racingKey), 1);
			await Season2.captureDueBrackets(shard, 4);
			assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(4, '100:1'), 'level'), '3');
		}));
	}

	test('RCL 2 is sufficient and uses accumulated control points', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard, '100', 2, 50);
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(2, '100:1'), 'controlPoints'), '250');
	}));

	for (const field of [ 'room', 'controller' ]) {
		test(`a foreign ${field} owner prevents scoring`, () => fresh(async ({ shard }) => {
			using settings = shortBrackets();
			await setup(shard);
			const room = await own(shard);
			if (field === 'room') {
				room['#user'] = '101';
			} else {
				room.controller!['#user'] = '101';
			}
			await shard.saveRoom(room.name, shard.time, room);
			await Season2.startRun(shard, '100', 'E3N3', 0);
			await Season2.captureDueBrackets(shard, 2);
			await noScore(shard);
		}));
	}

	test('an unreadable room does not score or break the shard tick', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		const original = shard.loadRoom.bind(shard);
		shard.loadRoom = () => Promise.reject(new Error('temporary fixture room read failure'));
		try {
			await Season2.captureDueBrackets(shard, 2);
			await noScore(shard);
			assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 1);
		} finally {
			shard.loadRoom = original;
		}
	}));

	test('corrupt out-of-block run metadata cannot write a new result', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await shard.db.data.hSet(Season2.runKey('100'), 'room', 'W3N3');
		await Season2.captureDueBrackets(shard, 2);
		await noScore(shard);
	}));

	test('a superseded run never scores but the new run does', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await Season2.startRun(shard, '100', 'E3N3', 1);
		await Season2.captureDueBrackets(shard, 2);
		await noScore(shard);
		await Season2.captureDueBrackets(shard, 3);
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(2, '100:2'), 'tick'), '3');
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1'))), []);
		assert.deepStrictEqual(await shard.data.zRange(Season2.racingKey, 0, -1), [ '100:2' ]);
	}));

	test('explicit stop rejects replayed brackets', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await Season2.stopRun(shard, '100', 1);
		await shard.data.zAdd(Season2.dueRunsKey, [ [ 2, '100:1:2' ] ]);
		await Season2.captureDueBrackets(shard, 2);
		await noScore(shard);
	}));

	test('switching to season 1 rejects later new-season captures and keeps already recorded history', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard);
		const before = await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1'));
		await Season1.startRun(shard, '100', 'W3N3', 3);
		await shard.data.zAdd(Season2.dueRunsKey, [ [ 4, '100:1:4' ] ]);
		await Season2.captureDueBrackets(shard, 4);
		await noScore(shard, '100:1', 4);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1')), before);
		assert.strictEqual((await Season2.readLeaderboard(shard, 2, 0, 10)).count, 1);
	}));

	test('repeated tick and replayed queue entries cannot overwrite the first captured result', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await Season2.captureDueBrackets(shard, 2);
		const before = await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1'));
		await own(shard, '100', 4, 9000);
		await Season2.captureDueBrackets(shard, 2);
		await shard.data.zAdd(Season2.dueRunsKey, [ [ 2, '100:1:2' ] ]);
		await Season2.captureDueBrackets(shard, 3);
		assert.strictEqual(await Season2.captureBracket(shard, '100:1:2', 3), undefined);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season2.scoreKey(2, '100:1')), before);
		assert.strictEqual(await shard.db.data.zScore(Season2.rankKey(2), '100:1'), 46200);
		assert.strictEqual(await shard.db.data.zScore(Season2.bestKey(2), '100'), 46200);
		assert.strictEqual(await shard.db.data.zCard(Season2.playerRunsKey(2, '100')), 1);
	}));

	test('concurrent captures serialize and write only one result', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		const captured = await Promise.all([
			Season2.captureBracket(shard, '100:1:2', 2),
			Season2.captureBracket(shard, '100:1:2', 2),
		]);
		assert.strictEqual(captured.filter(result => result === '100:1').length, 1);
		assert.strictEqual(await shard.db.data.zCard(Season2.rankKey(2)), 1);
	}));

	test('two concurrent due drains still preserve one historical snapshot', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		await Promise.all([ Season2.captureDueBrackets(shard, 2), Season2.captureDueBrackets(shard, 3) ]);
		assert.strictEqual(await shard.db.data.zCard(Season2.rankKey(2)), 1);
		assert.strictEqual(await shard.db.data.zCard(Season2.playerRunsKey(2, '100')), 1);
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 1);
	}));

	test('a worse later run adds history without lowering the best', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard);
		await score(shard, '100', 2, 50, 10);
		const board = await Season2.readLeaderboard(shard, 2, 0, 10);
		assert.strictEqual(board.count, 1);
		assert.strictEqual(board.list[0]!.score, 46200);
		assert.strictEqual(board.list[0]!.record!.run, 1);
		const records = await Season2.readPlayerRecords(shard, '100', [ 2 ]);
		assert.deepStrictEqual(records.map(entry => [ entry.record.run, entry.score, entry.rank ]), [ [ 1, 46200, 0 ], [ 2, 250, 1 ] ]);
		assert.strictEqual(await shard.db.data.hGet(Season2.playerBracketsKey('100'), '2'), '46200');
	}));

	test('a better later run updates best and retains both old results', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard);
		await score(shard, '100', 4, 200, 10);
		assert.strictEqual(await shard.db.data.zScore(Season2.bestKey(2), '100'), 180400);
		assert.strictEqual(await shard.db.data.hGet(Season2.playerBracketsKey('100'), '2'), '180400');
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(2, '100:1'), 'controlPoints'), '46200');
		assert.strictEqual((await Season2.readLeaderboard(shard, 2, 0, 10)).list[0]!.record!.run, 2);
		assert.strictEqual((await Season2.readPlayerRecords(shard, '100', [ 2 ])).length, 2);
	}));

	test('equal runs keep one best row and retain both records with legacy tie ordering', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard);
		await score(shard, '100', 3, 1000, 10);
		assert.strictEqual(await shard.db.data.zCard(Season2.bestKey(2)), 1);
		const records = await Season2.readPlayerRecords(shard, '100', [ 2 ]);
		assert.deepStrictEqual(records.map(entry => [ entry.record.run, entry.rank ]), [ [ 2, 0 ], [ 1, 1 ] ]);
		assert.strictEqual((await Season2.readLeaderboard(shard, 2, 0, 10)).list[0]!.score, 46200);
	}));

	test('the same user:run in both seasons has independent results, best scores and readers', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await own(shard, '100', 4, 200, 'W3N3');
		await Season1.startRun(shard, '100', 'W3N3', 0);
		await Season1.captureBracket(shard, '100:1:20000', 20000);
		await score(shard, '100', 3, 1000, 20001);
		assert.strictEqual((await Season1.readLeaderboard(shard, 20000, 0, 10)).list[0]!.record!.room, 'W3N3');
		assert.strictEqual((await Season2.readLeaderboard(shard, 2, 0, 10)).list[0]!.record!.room, 'E3N3');
		assert.strictEqual(await shard.db.data.zScore(Season1.bestKey(20000), '100'), 180400);
		assert.strictEqual(await shard.db.data.zScore(Season2.bestKey(2), '100'), 46200);
		assert.deepStrictEqual(await Season2.readPlayerBrackets(shard, '100'), [ { bracket: 2, score: 46200 } ]);
		assert.deepStrictEqual(await Season2.readPlayerRecords(shard, '100', [ 20000 ]), []);
		assert.deepStrictEqual(await Season1.readPlayerRecords(shard, '100', [ 2 ]), []);
	}));

	test('old run numbers are never borrowed by the new season', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await shard.db.data.hSet(Season1.runKey('100'), 'run', '99');
		await score(shard);
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'run'), '1');
		assert.strictEqual(await shard.db.data.hGet(Season1.runKey('100'), 'run'), '99');
	}));

	test('pagination and zero-based tie ranks are stable across player histories', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard, '100');
		await score(shard, '101');
		await score(shard, '102', 4, 200);
		const board = await Season2.readLeaderboard(shard, 2, 0, 10);
		assert.deepStrictEqual(board.list.map(entry => [ entry.user, entry.rank ]), [ [ '102', 0 ], [ '101', 1 ], [ '100', 2 ] ]);
		const page = await Season2.readLeaderboard(shard, 2, 1, 1);
		assert.strictEqual(page.count, 3);
		assert.deepStrictEqual(page.list.map(entry => [ entry.user, entry.rank ]), [ [ '101', 1 ] ]);
		assert.strictEqual((await Season2.readPlayerRecords(shard, '100', [ 2 ]))[0]!.rank, 2);
		assert.deepStrictEqual((await Season2.readLeaderboard(shard, 2, 3, 10)).list, []);
	}));

	test('out-of-block rows in new tables are filtered before paging and cannot override a valid best', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		await setup(shard);
		await score(shard);
		for (const [ user, run ] of [ [ '101', '1' ], [ '100', '99' ] ]) {
			await shard.db.data.hSet(Season2.scoreKey(2, `${user}:${run}`), 'room', 'W3N3');
			await shard.db.data.hSet(Season2.scoreKey(2, `${user}:${run}`), 'controlPoints', '999999');
			await shard.db.data.zAdd(Season2.rankKey(2), [ [ 999999, `${user}:${run}` ] ]);
			await shard.db.data.zAdd(Season2.bestKey(2), [ [ 999999, user! ] ]);
			await shard.db.data.zAdd(Season2.playerRunsKey(2, user!), [ [ 999999, run! ] ]);
		}
		const board = await Season2.readLeaderboard(shard, 2, 0, 1);
		assert.strictEqual(board.count, 1);
		assert.strictEqual(board.list[0]!.record!.run, 1);
		assert.strictEqual(board.list[0]!.score, 46200);
		const records = await Season2.readPlayerRecords(shard, '100', [ 2 ]);
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0]!.rank, 0);
		assert.strictEqual(await shard.db.data.hGet(Season2.scoreKey(2, '100:99'), 'room'), 'W3N3');
	}));

	test('empty configured brackets do not start or score a run', () => fresh(async ({ shard }) => {
		using settings = shortBrackets();
		config.speedrunSeason2!.raceBrackets = [];
		await setup(shard);
		await own(shard);
		assert.strictEqual(await Season2.startRun(shard, '100', 'E3N3', 0), undefined);
		await runShardTickProcessors(shard, 10);
		await noScore(shard);
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 0);
	}));

	test('a real restart retains old results and consumes the next bracket from persistent storage', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xs2-score-'));
		try {
			await fs.writeFile(path.join(directory, '.screepsrc.yaml'), JSON.stringify({
				mods: [ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ],
				// This persisted fixture isolates score recovery, not the timed-respawn suite.
				speedrunSeason2: { raceBrackets: [ 2, 4 ], respawnAfter: 0 },
				runner: { sandbox: 'unsafe' },
			}));
			const run = async (source: string) => (await command(process.execPath,
				[ '--experimental-vm-modules', binary, 'eval', '-e', source ],
				{ cwd: directory, timeout: 8000, maxBuffer: 1024 * 1024 })).stdout.trim().split('\n').at(-1)!;
			const imports = `
				const {Database,Shard}=await import('xxscreeps/engine/db/index.js');
				const {config}=await import('xxscreeps/config/index.js');
				const {runShardTickProcessors}=await import('xxscreeps/engine/processor/shard.js');
				const race=await import('xxscreeps/mods/speedrun-season2/race.js');
				await import('xxscreeps:mods/main');
				await using db=await Database.connect();
				await using shard=await Shard.connect(db,config.shards[0].name);`;
			const before = JSON.parse(await run(`(async () => {
				${imports}
				const {readFile}=await import('node:fs/promises');
				const {importPayload,seedShard}=await import('xxscreeps/scripts/payload.js');
				const {initializeSeason2Map}=await import('xxscreeps/mods/speedrun-season2/map.js');
				await seedShard(shard,importPayload(JSON.parse(await readFile(${JSON.stringify(fixture)},'utf8'))));
				await initializeSeason2Map(shard,{serverStopped:true});
				const room=await shard.loadRoom('E3N3');
				room['#user']=room.controller['#user']='100';room['#level']=3;
				room.controller['#progress']=1000;room.controller['#downgradeTime']=100000;
				await shard.saveRoom('E3N3',0,room);
				await race.startRun(shard,'100','E3N3',0);
				await runShardTickProcessors(shard,2);
				await shard.data.set('time',2);await shard.save();await db.save();
				return JSON.stringify(await db.data.hGetAll(race.scoreKey(2,'100:1')));
			})()`)) as Record<string, string>;
			const after = JSON.parse(await run(`(async () => {
				${imports}
				await runShardTickProcessors(shard,4);
				const result={
					first:await db.data.hGetAll(race.scoreKey(2,'100:1')),
					second:await db.data.hGetAll(race.scoreKey(4,'100:1')),
					brackets:await race.readPlayerBrackets(shard,'100'),
					due:await shard.data.zCard(race.dueRunsKey),
					racing:await shard.data.zCard(race.racingKey),
					ended:await db.data.hGet(race.runKey('100'),'endedTick'),
					old:await db.data.zCard('speedrun/rank/2'),
				};
				await shard.save();await db.save();
				return JSON.stringify(result);
			})()`)) as {
				first: Record<string, string>; second: Record<string, string>; brackets: { bracket: number; score: number }[];
				due: number; racing: number; ended: string | null; old: number;
			};
			assert.strictEqual(before.tick, '2');
			assert.deepStrictEqual(after.first, before);
			assert.strictEqual(after.second.tick, '4');
			assert.strictEqual(after.second.controlPoints, '46200');
			assert.deepStrictEqual(after.brackets, [ { bracket: 2, score: 46200 }, { bracket: 4, score: 46200 } ]);
			assert.deepStrictEqual([ after.due, after.racing, after.ended, after.old ], [ 0, 1, null, 0 ]);
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
