import type { RaceSettings } from './race-core.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { config } from 'xxscreeps/config/index.js';
import { intentProcessors, roomTickProcessors, shardInitializers, shardTickProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { controlPointsOf, createRace, makeRaceKeys, runIdOf } from './race-core.js';
import * as Legacy from './race.js';

/** Synthetic scopes exercise reuse without creating a real season-2 map or registering its race. */
const scopedRace = (namespace: string, room: string, settings: RaceSettings = { raceBrackets: [ 2, 4 ], respawnAfter: 50 }) =>
	createRace({ namespace, containsRoom: name => name === room, getSettings: () => settings });

function ownRoom(room: Room, userId: string, level: number, progress: number) {
	room['#user'] = room.controller!['#user'] = userId;
	room['#level'] = level;
	room.controller!['#progress'] = progress;
	room.controller!['#downgradeTime'] = 100000;
	room['#insertObject'](createCreep(new RoomPosition(25, 25, room.name), [ C.MOVE ], `core-${userId}`, userId));
}

const racers = simulate({
	W3N3: room => ownRoom(room, '100', 3, 1000),
	W4N3: room => ownRoom(room, '101', 4, 200),
});

describe('race core', () => {
	test('all legacy storage keys and member formats stay unchanged', () => {
		assert.strictEqual(Legacy.dueRunsKey, 'speedrun/due');
		assert.strictEqual(Legacy.racingKey, 'speedrun/racing');
		assert.strictEqual(Legacy.runKey('100'), 'speedrun/run/100');
		assert.strictEqual(Legacy.scoreKey(2, '100:17'), 'speedrun/score/2/100:17');
		assert.strictEqual(Legacy.rankKey(2), 'speedrun/rank/2');
		assert.strictEqual(Legacy.bestKey(2), 'speedrun/best/2');
		assert.strictEqual(Legacy.playerRunsKey(2, '100'), 'speedrun/runs/2/100');
		assert.strictEqual(Legacy.playerBracketsKey('100'), 'speedrun/brackets/100');
		assert.strictEqual(Legacy.runIdOf, runIdOf);
		assert.strictEqual(Legacy.controlPointsOf, controlPointsOf);
		assert.strictEqual(runIdOf('100', 17), '100:17');
		assert.strictEqual(controlPointsOf(3, 1000), 46200);
	});

	test('every key uses the supplied namespace, including current state and queues', () => {
		const keys = makeRaceKeys('speedrun-season2');
		assert.deepStrictEqual([
			keys.dueRunsKey, keys.racingKey, keys.runKey('100'), keys.scoreKey(2, '100:1'),
			keys.rankKey(2), keys.bestKey(2), keys.playerRunsKey(2, '100'), keys.playerBracketsKey('100'),
		], [
			'speedrun-season2/due', 'speedrun-season2/racing', 'speedrun-season2/run/100',
			'speedrun-season2/score/2/100:1', 'speedrun-season2/rank/2', 'speedrun-season2/best/2',
			'speedrun-season2/runs/2/100', 'speedrun-season2/brackets/100',
		]);
	});

	test('construction is lazy and adds no gameplay or tick hooks', () => {
		const before = [ intentProcessors.length, roomTickProcessors.length, shardInitializers.length, shardTickProcessors.length ];
		let settingsReads = 0;
		createRace({
			namespace: 'unused-race',
			containsRoom: () => true,
			getSettings: () => {
				++settingsReads;
				return { raceBrackets: [ 2 ] };
			},
		});
		assert.strictEqual(settingsReads, 0);
		assert.deepStrictEqual(
			[ intentProcessors.length, roomTickProcessors.length, shardInitializers.length, shardTickProcessors.length ],
			before,
		);
	});

	test('settings are read live from the explicit getter without mutating global configuration', () => {
		const before = JSON.stringify(config.speedrun);
		let settings: RaceSettings | undefined = { raceBrackets: [ 2, 4 ], respawnAfter: 9 };
		const race = createRace({ namespace: 'settings-test', containsRoom: () => true, getSettings: () => settings });
		assert.deepStrictEqual(race.raceBrackets(), [ 2, 4 ]);
		assert.strictEqual(race.respawnAfter(), 9);
		settings = { raceBrackets: [ 7, 3 ] };
		assert.deepStrictEqual(race.raceBrackets(), [ 7, 3 ]);
		assert.strictEqual(race.respawnAfter(), 7);
		settings = { raceBrackets: [], respawnAfter: 0 };
		assert.deepStrictEqual(race.raceBrackets(), []);
		assert.strictEqual(race.respawnAfter(), 0);
		settings = { raceBrackets: [ 4 ], respawnAfter: -1 };
		assert.strictEqual(race.respawnAfter(), 0);
		settings = undefined;
		assert.deepStrictEqual(race.raceBrackets(), []);
		assert.strictEqual(race.respawnAfter(), 0, 'there is no fallback to the global season-1 config');
		assert.strictEqual(JSON.stringify(config.speedrun), before);
	});

	test('the legacy adapter follows a replaced config root instead of a startup snapshot', () => {
		const previous = config.speedrun;
		try {
			config.speedrun = { raceBrackets: [ 3, 7 ], respawnAfter: 11 };
			assert.deepStrictEqual(Legacy.raceBrackets(), [ 3, 7 ]);
			assert.strictEqual(Legacy.respawnAfter(), 11);
			config.speedrun = { raceBrackets: [ 5 ] };
			assert.strictEqual(Legacy.respawnAfter(), 5);
		} finally {
			if (previous === undefined) {
				delete config.speedrun;
			} else {
				config.speedrun = previous;
			}
		}
	});

	test('the room predicate gates starts without overwriting a valid current run', () => racers(async ({ shard }) => {
		const race = scopedRace('scope-test', 'W3N3');
		assert.strictEqual(await race.startRun(shard, '100', 'W3N3', shard.time), 1);
		const before = await shard.db.data.hGetAll(race.runKey('100'));
		for (const room of [ 'W4N3', 'E3N3', 'W0N0' ]) {
			assert.strictEqual(await race.startRun(shard, '100', room, shard.time), undefined);
		}
		assert.deepStrictEqual(await shard.db.data.hGetAll(race.runKey('100')), before);
		assert.strictEqual(await shard.data.zCard(race.racingKey), 1);
		assert.strictEqual(await shard.data.zCard(race.dueRunsKey), 2);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Legacy.runKey('100'))), []);
	}));

	test('empty brackets schedule no run or expiry task', () => racers(async ({ shard }) => {
		const race = scopedRace('empty-test', 'W3N3', { raceBrackets: [], respawnAfter: 50 });
		assert.strictEqual(await race.startRun(shard, '100', 'W3N3', shard.time), undefined);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(race.runKey('100'))), []);
		assert.strictEqual(await shard.data.zCard(race.dueRunsKey), 0);
		assert.strictEqual(await shard.data.zCard(race.racingKey), 0);
	}));

	test('the same player has independent run numbers and due queues in two instances', () => racers(async ({ shard }) => {
		const first = scopedRace('instance-a', 'W3N3');
		const second = scopedRace('instance-b', 'W4N3', { raceBrackets: [ 3 ], respawnAfter: 60 });
		assert.strictEqual(await first.startRun(shard, '100', 'W3N3', shard.time), 1);
		assert.strictEqual(await second.startRun(shard, '100', 'W4N3', shard.time), 1);
		assert.strictEqual(await first.startRun(shard, '100', 'W3N3', shard.time), 2);
		assert.strictEqual(await shard.db.data.hGet(first.runKey('100'), 'run'), '2');
		assert.strictEqual(await shard.db.data.hGet(second.runKey('100'), 'run'), '1');
		assert.deepStrictEqual(await shard.data.zRange(first.racingKey, 0, -1), [ '100:2' ]);
		assert.deepStrictEqual(await shard.data.zRange(second.racingKey, 0, -1), [ '100:1' ]);
		assert.deepStrictEqual(await shard.data.zRange(second.dueRunsKey, 0, -1), [ '100:1:3' ]);
		assert.strictEqual(await shard.data.zCard(Legacy.dueRunsKey), 0);
	}));

	test('pre-refactor active runs and due entries continue scoring without migration', () => racers(async ({ shard }) => {
		const settings = config.speedrun!;
		const previous = settings.raceBrackets;
		settings.raceBrackets = [ 2 ];
		try {
			const time = shard.time;
			const fields = { run: '17', room: 'W3N3', startedTick: String(time - 2) };
			for (const [ field, value ] of Object.entries(fields)) {
				await shard.db.data.hSet('speedrun/run/100', field, value);
			}
			await shard.data.zAdd('speedrun/due', [ [ time, '100:17:2' ] ]);
			await shard.data.zAdd('speedrun/racing', [ [ time - 2, '100:17' ] ]);
			await Legacy.captureDueBrackets(shard, time);
			const result = await shard.db.data.hGetAll('speedrun/score/2/100:17');
			assert.strictEqual(result.run, '17');
			assert.strictEqual(result.elapsed, '2');
			assert.strictEqual(result.controlPoints, '46200');
			assert.deepStrictEqual({ ...await shard.db.data.hGetAll('speedrun/run/100') }, fields);
			assert.strictEqual(await shard.data.zCard('speedrun/due'), 0);
			assert.strictEqual(await shard.data.zCard('speedrun/racing'), 1);
			assert.strictEqual((await Legacy.readLeaderboard(shard, 2, 0, 10)).list[0]?.record?.run, 17);
			assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll('speedrun-season2/run/100')), []);
		} finally {
			if (previous === undefined) {
				delete settings.raceBrackets;
			} else {
				settings.raceBrackets = previous;
			}
		}
	}));

	test('only explicit calls drain a private instance queue and record its bracket', () => racers(async ({ shard, tick }) => {
		const race = scopedRace('manual-test', 'W3N3');
		await race.startRun(shard, '100', 'W3N3', shard.time);
		await tick(2);
		assert.strictEqual(await shard.db.data.zCard(race.rankKey(2)), 0, 'no private tick hook was registered');
		await race.captureDueBrackets(shard, shard.time);
		assert.strictEqual(await shard.db.data.zCard(race.rankKey(2)), 1);
		assert.strictEqual(await shard.db.data.zCard(race.rankKey(4)), 0);
		assert.deepStrictEqual(await shard.data.zRange(race.dueRunsKey, 0, -1), [ '100:1:4' ]);
		assert.strictEqual(await shard.db.data.zCard(Legacy.rankKey(2)), 0);
	}));

	test('scores, history and live boards use their own namespace and room predicate', () => racers(async ({ shard, poke }) => {
		await poke('W4N3', '100', (_Game, room) => {
			room['#user'] = room.controller!['#user'] = '100';
		});
		const first = scopedRace('scores-a', 'W3N3');
		const second = scopedRace('scores-b', 'W4N3');
		await first.startRun(shard, '100', 'W3N3', shard.time - 2);
		await second.startRun(shard, '100', 'W4N3', shard.time - 2);
		await first.captureDueBrackets(shard, shard.time);
		await second.captureDueBrackets(shard, shard.time);
		assert.strictEqual((await first.readLeaderboard(shard, 2, 0, 10)).list[0]?.score, 46200);
		assert.strictEqual((await second.readLeaderboard(shard, 2, 0, 10)).list[0]?.score, 180400);
		assert.deepStrictEqual(await first.readPlayerBrackets(shard, '100'), [ { bracket: 2, score: 46200 } ]);
		assert.strictEqual((await second.readPlayerRecords(shard, '100', [ 2 ]))[0]?.record.room, 'W4N3');
		assert.strictEqual((await first.readRacing(shard, shard.time))[0]?.room, 'W3N3');
		assert.strictEqual((await second.readRacing(shard, shard.time))[0]?.room, 'W4N3');
		// A stale foreign-room high score in one namespace must not suppress its valid best.
		const fields = await shard.db.data.hGetAll(first.scoreKey(2, '100:1'));
		const foreign = { ...fields, room: 'W4N3', run: '99', runId: '100:99', controlPoints: '999999' };
		await Promise.all([
			...Object.entries(foreign).map(([ field, value ]) => shard.db.data.hSet(first.scoreKey(2, '100:99'), field, value)),
			shard.db.data.zAdd(first.bestKey(2), [ [ 999999, '100' ] ]),
			shard.db.data.zAdd(first.rankKey(2), [ [ 999999, '100:99' ] ]),
			shard.db.data.zAdd(first.playerRunsKey(2, '100'), [ [ 999999, '99' ] ]),
		]);
		assert.strictEqual((await first.readLeaderboard(shard, 2, 0, 10)).list[0]?.score, 46200);
		const records = await first.readPlayerRecords(shard, '100', [ 2 ]);
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0]?.rank, 0);
		assert.strictEqual((await second.readLeaderboard(shard, 2, 0, 10)).list[0]?.score, 180400);
		assert.strictEqual((await Legacy.readLeaderboard(shard, 2, 0, 10)).count, 0);
	}));

	test('stopping one instance does not cancel another instance for the same player', () => racers(async ({ shard }) => {
		const first = scopedRace('stop-a', 'W3N3');
		const second = scopedRace('stop-b', 'W4N3');
		await first.startRun(shard, '100', 'W3N3', shard.time);
		await second.startRun(shard, '100', 'W4N3', shard.time);
		await first.captureBracket(shard, '100:1:2', shard.time + 2);
		await first.stopRun(shard, '100', shard.time + 3);
		assert.strictEqual(await shard.db.data.hGet(first.runKey('100'), 'endedTick'), String(shard.time + 3));
		assert.strictEqual(await shard.data.zCard(first.dueRunsKey), 0);
		assert.strictEqual(await shard.data.zCard(first.racingKey), 0);
		assert.strictEqual(await shard.db.data.zCard(first.rankKey(2)), 1, 'historical scores survive stopping');
		assert.strictEqual(await shard.db.data.hGet(second.runKey('100'), 'endedTick'), null);
		assert.strictEqual(await shard.data.zCard(second.dueRunsKey), 2);
		assert.strictEqual(await shard.data.zCard(second.racingKey), 1);
	}));

	test('expiry uses the explicit window and only reads its own run queue', () => racers(async ({ shard, tick, peekRoom }) => {
		const first = scopedRace('expiry-a', 'W3N3', { raceBrackets: [ 2 ], respawnAfter: 3 });
		const second = scopedRace('expiry-b', 'W4N3', { raceBrackets: [ 2 ], respawnAfter: 60 });
		await first.startRun(shard, '100', 'W3N3', shard.time);
		await second.startRun(shard, '101', 'W4N3', shard.time);
		await tick(2);
		await first.resetExpiredRuns(shard, shard.time);
		assert.strictEqual(await shard.db.data.hGet(first.runKey('100'), 'endedTick'), null);
		await tick();
		await first.resetExpiredRuns(shard, shard.time);
		assert.strictEqual(await shard.db.data.hGet(first.runKey('100'), 'endedTick'), String(shard.time));
		await tick();
		assert.strictEqual(await peekRoom('W3N3', room => room['#user']), null);
		assert.strictEqual(await peekRoom('W4N3', room => room['#user']), '101');
		assert.strictEqual(await shard.db.data.hGet(second.runKey('101'), 'endedTick'), null);
		assert.strictEqual(await shard.data.zCard(second.racingKey), 1);
	}));

	test('a controlled room outside the supplied scope prevents an obsolete global respawn', () => simulate({
		W3N3: room => ownRoom(room, '100', 3, 1000),
		W4N3: room => ownRoom(room, '100', 4, 200),
	})(async ({ shard, tick, peekRoom }) => {
		const race = scopedRace('outside-reset', 'W3N3', { raceBrackets: [ 2 ], respawnAfter: 2 });
		await race.startRun(shard, '100', 'W3N3', shard.time);
		await tick(2);
		await race.resetExpiredRuns(shard, shard.time);
		await tick();
		assert.strictEqual(await peekRoom('W3N3', room => room['#user']), '100');
		assert.strictEqual(await peekRoom('W4N3', room => room['#user']), '100');
		assert.strictEqual(await shard.data.zCard(race.racingKey), 0);
		assert.strictEqual(await shard.data.zCard(race.dueRunsKey), 0);
	}));

	test('enabling the extension still does not start any season-2 clock', () => racers(async ({ shard, tick }) => {
		await Legacy.startRun(shard, '100', 'W3N3', shard.time);
		await tick(3);
		const keys = makeRaceKeys('speedrun-season2');
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(keys.runKey('100'))), []);
		assert.strictEqual(await shard.data.zCard(keys.dueRunsKey), 0);
		assert.strictEqual(await shard.data.zCard(keys.racingKey), 0);
		assert.strictEqual(await shard.db.data.zCard(keys.bestKey(20000)), 0);
	}));
});
