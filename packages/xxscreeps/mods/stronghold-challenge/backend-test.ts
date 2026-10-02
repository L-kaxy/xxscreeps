import type { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { hooks } from 'xxscreeps/backend/index.js';
import { Render } from 'xxscreeps/backend/symbols.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { PWR_OPERATE_SPAWN } from './constants.js';
import { activeKey, runKey } from './race.js';
import { challengeRankingKeys } from './ranking.js';
import { writeRankedRun } from './runs.js';
import { loadChallengePair, pairKey, prepareStrongholdChallenge } from './setup.js';
import './effects-test.js';
import 'xxscreeps:mods/backend';

const prefix = '/api/stronghold-challenge/';

async function execute(db: Database, shard: Shard, path: string, query: Record<string, string> = {}, params: Record<string, string> = {}) {
	const endpoint = [ ...hooks.map('route') ].find(endpoint => endpoint.path === prefix + path);
	if (endpoint === undefined) {
		throw new Error(`Missing challenge route ${path}`);
	}
	const result = await endpoint.execute({ db, shard, params, request: { query } } as Parameters<typeof endpoint.execute>[0]);
	// Exercise the JSON representation clients receive, including numeric record fields.
	return JSON.parse(JSON.stringify(result)) as unknown;
}

describe('stronghold challenge backend', () => {
	test('best-score board, pagination and history share the public record shape', async () => {
		await using refs = await instantiateTestShard();
		const { db, shard } = refs;
		const keys = challengeRankingKeys(shard.name);
		const record = (user: string, runId: string, elapsed: number) => ({
			user, runId, elapsed, at: 1000, room: 'E1S1', targetRoom: 'E2S1', startedTick: 100, finishedTick: 100 + elapsed,
		});
		const runs = [ record('100', '100:1', 30), record('100', '100:2', 20), record('101', '101:1', 10) ];
		for (const record of runs) {
			await writeRankedRun(db.data, keys, 'ascending', {
				user: record.user, runId: record.runId, score: record.elapsed,
				fields: Object.fromEntries(Object.entries(record).map(([ key, value ]) => [ key, String(value) ])),
			});
		}
		assert.deepStrictEqual(await execute(db, shard, 'leaderboard', { offset: '1', limit: '1' }), {
			ok: 1, count: 2,
			list: [ { rank: 1, user: '100', score: 20, record: runs[1] } ],
			users: { 100: { _id: '100', username: 'Player 1', badge: null } },
		});
		assert.deepStrictEqual(await execute(db, shard, 'records/:user', {}, { user: '100' }), {
			ok: 1, user: '100', username: 'Player 1',
			list: [ { rank: 1, score: 20, record: runs[1] }, { rank: 2, score: 30, record: runs[0] } ],
		});
		assert.deepStrictEqual(await execute(db, shard, 'records/:user', {}, { user: 'missing' }), {
			ok: 1, user: 'missing', username: '[deleted]', list: [],
		});
		const queries: Record<string, string>[] = [ { limit: '0' }, { limit: '101' }, { limit: 'bad' }, { offset: '-1' }, { offset: '1.5' } ];
		for (const query of queries) {
			assert.deepStrictEqual(await execute(db, shard, 'leaderboard', query), { error: 'invalid' });
		}
	});

	test('live board uses stored time and excludes won and stale active entries', async () => {
		await using refs = await instantiateTestShard();
		const { db, shard } = refs;
		await shard.data.set('time', 1000);
		await shard.data.sAdd(activeKey, [ '100', '101', 'missing' ]);
		await shard.data.hmSet(runKey('100'), {
			run: '900', room: 'E1S1', targetRoom: 'E2S1', startedTick: '900', deadlineTick: '1500', coreId: 'target-core', state: 'running',
		});
		await shard.data.hmSet(runKey('101'), { state: 'won' });
		const { tickSpeed, ...response } = await execute(db, shard, 'racing') as { [key: string]: unknown; tickSpeed: unknown };
		assert.strictEqual(typeof tickSpeed, 'number');
		assert.deepStrictEqual(response, {
			ok: 1, time: 1000,
			list: [ {
				coreId: 'target-core', deadlineTick: 1500, elapsed: 100, left: 500,
				room: 'E1S1', run: 900, startedTick: 900, state: 'running', targetRoom: 'E2S1', user: '100',
			} ],
			users: { 100: { _id: '100', username: 'Player 1', badge: null } },
		});
	});

	test('spawn renderer preserves permanent operate-spawn alongside ordinary store fields', async () => {
		await using refs = await instantiateTestShard();
		await prepareStrongholdChallenge(refs.shard);
		const world = await refs.shard.loadWorld();
		const [ name ] = await refs.shard.data.hKeys(pairKey);
		if (name === undefined) {
			throw new Error('A prepared challenge must contain a pair');
		}
		const pair = await loadChallengePair(refs.shard, name);
		if (pair === undefined) {
			throw new Error('A prepared challenge must retain its pair metadata');
		}
		const room = await refs.shard.loadRoom(pair.home);
		const spawn = createSpawn(new RoomPosition(25, 25, room.name), '100', 'Spawn1');
		room['#insertObject'](spawn);
		room['#flushObjects'](null);
		const rendered = runOneShot(world, room, 1000, '100', () => spawn[Render]()) as unknown as {
			effects: unknown;
			store: { energy: number };
			storeCapacityResource: { energy: number };
		};
		assert.deepStrictEqual(rendered.effects, [ { power: PWR_OPERATE_SPAWN, level: 5 } ]);
		assert.strictEqual(rendered.store.energy, 300);
		assert.strictEqual(rendered.storeCapacityResource.energy, 300);
	});
});
