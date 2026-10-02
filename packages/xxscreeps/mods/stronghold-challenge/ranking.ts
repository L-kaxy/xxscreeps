import type { RunRankingKeys } from './runs.js';

/** Scores live with accounts, but each shard's challenge has its own board. */
export function challengeRankingKeys(shardName: string): RunRankingKeys {
	const prefix = `stronghold-challenge/${shardName}`;
	return {
		best: `${prefix}/best`,
		rank: `${prefix}/rank`,
		record: runId => `${prefix}/score/${runId}`,
		runs: userId => `${prefix}/runs/${userId}`,
	};
}

export interface ChallengeRecord {
	at: number;
	elapsed: number;
	finishedTick: number;
	room: string;
	runId: string;
	startedTick: number;
	targetRoom: string;
	user: string;
}

export function parseChallengeRecord(fields: Record<string, string>): ChallengeRecord {
	return {
		at: Number(fields.at),
		elapsed: Number(fields.elapsed),
		finishedTick: Number(fields.finishedTick),
		room: fields.room!,
		runId: fields.runId!,
		startedTick: Number(fields.startedTick),
		targetRoom: fields.targetRoom!,
		user: fields.user!,
	};
}
