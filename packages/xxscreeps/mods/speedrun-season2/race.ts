import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { createRace } from 'xxscreeps/mods/speedrun/race-core.js';
import { activeRunKey, createSeasonRace, isCurrentSeasonRun } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import { isSeason2Room } from './rooms.js';

const definition = {
	namespace: 'speedrun-season2',
	containsRoom: isSeason2Room,
	getSettings: () => config.speedrunSeason2,
	captureOnce: true,
} as const;
const race = createSeasonRace(definition);
// Only the raw stop operation is used, while holding the same account lock as the season adapter.
// Calling the adapter's stop inside that lock would deadlock (as would its generic auto-respawn).
const { stopRun: stopLockedRun } = createRace(definition);

/** Written under the block gate before a successful handover releases it. Not a score table. */
export const landingKey = 'speedrun-season2/landing';

export interface RunIdentity {
	run: string;
	room: string;
	startedTick: string;
}

/** A new player's clock can be committed before its room buffer becomes current. */
export async function hasNewerSeason2Run(shard: Shard, user: string, startedTick: number) {
	const value = await shard.data.get(landingKey);
	const landing = value === null ? undefined : JSON.parse(value) as { user: string; startedTick: number };
	if (landing && landing.user !== user && landing.startedTick >= startedTick) {
		return true;
	}
	// Compatibility for players who landed before this marker was introduced.
	const others = await shard.data.zRange(race.racingKey, startedTick, Infinity, { by: 'SCORE' });
	for (const other of others) {
		const [ otherUser, otherRun ] = other.split(':');
		if (otherUser !== undefined && otherUser !== user) {
			const newer = await shard.db.data.hGetAll(race.runKey(otherUser));
			if (newer.run === otherRun && newer.endedTick === undefined && isSeason2Room(newer.room) &&
				await isCurrentSeasonRun(shard, definition.namespace, otherUser, newer)) {
				return true;
			}
		}
	}
	return false;
}

export async function withRunLock<Result>(shard: Shard, user: string, task: () => Promise<Result>) {
	await using mutex = await Mutex.connect(`speedrun/race/${user}`, shard.db.data, shard.db.pubsub);
	await using lock = await mutex.acquire();
	return await task();
}

/** Recover a reserved cleanup, but never end a newer run or a run in the other season/shard. */
export async function stopCleanupRun(shard: Shard, user: string, time: number, expected?: RunIdentity) {
	return withRunLock(shard, user, async () => {
		const value = await shard.db.data.get(activeRunKey(user));
		const current = value === null ? undefined : JSON.parse(value) as RunIdentity & {
			namespace: string; shard: string; active: boolean;
		};
		if (current?.active && (current.namespace !== definition.namespace || current.shard !== shard.name)) {
			return false;
		}
		if (expected) {
			const info = await shard.db.data.hGetAll(race.runKey(user));
			if (current?.namespace !== definition.namespace || current.shard !== shard.name ||
				([ 'run', 'room', 'startedTick' ] as const).some(key =>
					info[key] !== expected[key] || current[key] !== expected[key])) {
				return false;
			}
		}
		await stopLockedRun(shard, user, time);
		if (current?.namespace === definition.namespace && current.shard === shard.name) {
			await shard.db.data.set(activeRunKey(user), JSON.stringify({ ...current, active: false }));
		}
		return true;
	});
}

/** A failed capture stays due, and therefore prevents expiry from destroying the source room. */
export async function captureDueBrackets(shard: Shard, time: number) {
	const due = await shard.data.zRange(race.dueRunsKey, -Infinity, time, { by: 'SCORE' });
	for (const member of due) {
		try {
			await race.captureBracket(shard, member, time);
			await shard.data.zRem(race.dueRunsKey, [ member ]);
		} catch (error) {
			console.error(`speedrun-season2: capture ${member} failed; retaining it for retry`, error);
		}
	}
}

export type { LeaderboardEntry, PlayerRecord, RaceRecord } from 'xxscreeps/mods/speedrun/race-core.js';
export { controlPointsOf, runIdOf } from 'xxscreeps/mods/speedrun/race-core.js';

// The generic core auto-reset is intentionally not exported: this season uses durable block cleanup.
export const {
	dueRunsKey, racingKey, runKey, scoreKey, rankKey, bestKey, playerRunsKey, playerBracketsKey,
	raceBrackets, startRun, stopRun, captureBracket,
	readLeaderboard, readPlayerBrackets, readPlayerRecords, readRacing,
} = race;
