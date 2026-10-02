import type { KeyValProvider } from 'xxscreeps/engine/db/storage/provider.js';

/** Challenge boards keep every run, and a separate best score for each player. */
export interface RunRankingKeys {
	best: string;
	rank: string;
	record: (runId: string) => string;
	runs: (userId: string) => string;
	/** Older boards may store a run number rather than its full id in a player's run set. */
	memberOf?: (runId: string) => string;
	runIdOf?: (userId: string, member: string) => string;
}

export interface RankedRun {
	fields: Record<string, string>;
	runId: string;
	score: number;
	user: string;
}

/** Store a result without replacing a player's better result. Returns whether their best improved. */
export async function writeRankedRun(data: KeyValProvider, keys: RunRankingKeys, order: 'ascending' | 'descending', entry: RankedRun): Promise<boolean> {
	const { fields, runId, score, user } = entry;
	const best = await data.zScore(keys.best, user);
	const improves = best === null || (order === 'ascending' ? score < best : score > best);
	await Promise.all([
		data.hmSet(keys.record(runId), fields),
		data.zAdd(keys.rank, [ [ score, runId ] ]),
		data.zAdd(keys.runs(user), [ [ score, keys.memberOf?.(runId) ?? runId ] ]),
		data.zAdd(keys.best, [ [ score, user ] ], { up: order === 'ascending' ? 'LT' : 'GT' }),
	]);
	return improves;
}

export interface RunRankingEntry {
	/** Zero based, matching the client leaderboard convention. */
	rank: number;
	fields: Record<string, string> | undefined;
	score: number;
	user: string;
}

/** One page of players, with the best run of each player. */
export async function readRunRanking(data: KeyValProvider, keys: RunRankingKeys, order: 'ascending' | 'descending', offset: number, limit: number) {
	const rev = order === 'descending';
	const [ count, page ] = await Promise.all([
		data.zCard(keys.best),
		data.zRangeWithScores(keys.best, offset, offset + limit - 1, { rev }),
	]);
	const list = await Promise.all(page.map(async ([ score, user ], index): Promise<RunRankingEntry> => {
		const [ member ] = await data.zRange(keys.runs(user), 0, 0, { rev });
		const fields = member === undefined ? undefined
			: await data.hGetAll(keys.record(keys.runIdOf?.(user, member) ?? member));
		return { fields, rank: offset + index, score, user };
	}));
	return { count, list };
}

export interface RankedRunRecord {
	fields: Record<string, string>;
	/** Place among every run on the board, rather than among players' best runs. */
	rank: number | null;
	score: number;
}

/** All of one player's results, best first, retaining the rank of each individual run. */
export async function readRankedRuns(data: KeyValProvider, keys: RunRankingKeys, order: 'ascending' | 'descending', user: string) {
	const rev = order === 'descending';
	const runs = await data.zRangeWithScores(keys.runs(user), 0, -1, { rev });
	return Promise.all(runs.map(async ([ score, member ]): Promise<RankedRunRecord> => {
		const runId = keys.runIdOf?.(user, member) ?? member;
		const [ fields, rank ] = await Promise.all([
			data.hGetAll(keys.record(runId)),
			data.zRank(keys.rank, runId, { rev }),
		]);
		return { fields, rank, score };
	}));
}
