import type { RunRankingKeys } from './runs.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { readRankedRuns, readRunRanking, writeRankedRun } from './runs.js';

const keys: RunRankingKeys = {
	best: 'test-runs/best',
	rank: 'test-runs/rank',
	record: runId => `test-runs/record/${runId}`,
	runs: user => `test-runs/runs/${user}`,
};

describe('stronghold challenge ranking', () => {
	test('shortest runs win, while worse and equal runs remain in the player history', async () => {
		await using testShard = await instantiateTestShard();
		const { data } = testShard.db;
		const write = (user: string, runId: string, score: number) => writeRankedRun(data, keys, 'ascending', {
			user, runId, score, fields: { runId, user, elapsed: String(score) },
		});
		assert.strictEqual(await write('100', '100:1', 30), true);
		assert.strictEqual(await write('101', '101:1', 20), true);
		assert.strictEqual(await write('100', '100:2', 40), false);
		assert.strictEqual(await write('100', '100:3', 10), true);
		assert.strictEqual(await write('100', '100:4', 10), false);
		const page = await readRunRanking(data, keys, 'ascending', 0, 10);
		assert.strictEqual(page.count, 2);
		assert.deepStrictEqual(page.list.map(entry => [ entry.rank, entry.user, entry.score, entry.fields?.runId ]), [
			[ 0, '100', 10, '100:3' ], [ 1, '101', 20, '101:1' ],
		]);
		assert.deepStrictEqual((await readRankedRuns(data, keys, 'ascending', '100')).map(entry => [
			entry.fields.runId, entry.score, entry.rank,
		]), [ [ '100:3', 10, 0 ], [ '100:4', 10, 1 ], [ '100:1', 30, 3 ], [ '100:2', 40, 4 ] ]);
		assert.deepStrictEqual((await readRunRanking(data, keys, 'ascending', 1, 1)).list.map(entry => entry.rank), [ 1 ]);
		assert.deepStrictEqual((await readRunRanking(data, keys, 'ascending', 2, 1)).list, []);
		assert.deepStrictEqual(await readRankedRuns(data, keys, 'ascending', '404'), []);
	});

	test('highest scores win and numbered historical run members keep their existing keys', async () => {
		await using testShard = await instantiateTestShard();
		const { data } = testShard.db;
		const numbered: RunRankingKeys = {
			...keys,
			memberOf: runId => runId.slice(runId.indexOf(':') + 1),
			runIdOf: (user, member) => `${user}:${member}`,
		};
		// Seed a numbered run set to verify that key mapping preserves an existing board.
		await Promise.all([
			data.hmSet(keys.record('100:1'), { runId: '100:1', user: '100', controlPoints: '30' }),
			data.zAdd(keys.best, [ [ 30, '100' ] ]),
			data.zAdd(keys.rank, [ [ 30, '100:1' ] ]),
			data.zAdd(keys.runs('100'), [ [ 30, '1' ] ]),
		]);
		assert.strictEqual(await writeRankedRun(data, numbered, 'descending', {
			user: '100', runId: '100:2', score: 20, fields: { runId: '100:2', controlPoints: '20' },
		}), false);
		assert.strictEqual(await writeRankedRun(data, numbered, 'descending', {
			user: '101', runId: '101:1', score: 40, fields: { runId: '101:1', controlPoints: '40' },
		}), true);
		const page = await readRunRanking(data, numbered, 'descending', 0, 10);
		assert.deepStrictEqual(page.list.map(entry => [ entry.rank, entry.user, entry.score, entry.fields?.runId ]), [
			[ 0, '101', 40, '101:1' ], [ 1, '100', 30, '100:1' ],
		]);
		assert.deepStrictEqual(await data.zRange(keys.runs('100'), 0, -1), [ '2', '1' ]);
		assert.deepStrictEqual((await readRankedRuns(data, numbered, 'descending', '100')).map(entry => [
			entry.fields.runId, entry.score, entry.rank,
		]), [ [ '100:1', 30, 1 ], [ '100:2', 20, 2 ] ]);
	});
});
