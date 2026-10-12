import type { RaceDefinition } from './race-core.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { createRace } from './race-core.js';

/** Coordination only, never a score table. Kept after stopping to reject stale retries. */
export const activeRunKey = (userId: string) => `speedrun/active/${userId}`;

interface ActiveRun {
	namespace: string;
	shard: string;
	run: string;
	room: string;
	startedTick: string;
	active: boolean;
}

const seasons = new Map<string, ReturnType<typeof createRace>>();

async function withPlayerLock<Result>(shard: Shard, userId: string, task: () => Promise<Result>) {
	await using mutex = await Mutex.connect(`speedrun/race/${userId}`, shard.db.data, shard.db.pubsub);
	await using lock = await mutex.acquire();
	return await task();
}

export async function isCurrentSeasonRun(
	shard: Shard, namespace: string, userId: string, info: Record<string, string>,
) {
	const value = await shard.db.data.get(activeRunKey(userId));
	// Existing season-1 clocks predate this metadata and need no migration.
	if (value === null) {
		return namespace === 'speedrun';
	}
	const current = JSON.parse(value) as ActiveRun;
	return current.active && current.namespace === namespace && current.shard === shard.name
		&& current.run === info.run && current.room === info.room && current.startedTick === info.startedTick;
}

/** Register real seasons lazily. Importing an adapter never writes storage or adds tick hooks. */
export function createSeasonRace<Namespace extends string>(definition: RaceDefinition<Namespace>) {
	const { namespace, containsRoom } = definition;
	const race = createRace({
		...definition,
		isCurrentRun: (shard, userId, info) => isCurrentSeasonRun(shard, namespace, userId, info),
		withPlayerLock,
	});
	seasons.set(namespace, race);

	async function mark(shard: Shard, userId: string, room: string, time: number, run: number | undefined) {
		const current: ActiveRun = {
			namespace, shard: shard.name, room, startedTick: String(time),
			run: String(run ?? 0), active: run !== undefined,
		};
		await shard.db.data.set(activeRunKey(userId), JSON.stringify(current));
	}

	return {
		...race,
		async startRun(this: void, shard: Shard, userId: string, roomName: string, time: number) {
			if (!containsRoom(roomName)) {
				return undefined;
			}
			return withPlayerLock(shard, userId, async () => {
				// Raw stop functions do not acquire this same lock recursively.
				for (const [ name, other ] of seasons) {
					if (name !== namespace) {
						await other.stopRun(shard, userId, time);
					}
				}
				if (race.raceBrackets().length === 0) {
					await race.stopRun(shard, userId, time);
				}
				const run = await race.startRun(shard, userId, roomName, time);
				await mark(shard, userId, roomName, time, run);
				return run;
			});
		},
		async stopRun(this: void, shard: Shard, userId: string, time: number) {
			return withPlayerLock(shard, userId, async () => {
				await race.stopRun(shard, userId, time);
				const value = await shard.db.data.get(activeRunKey(userId));
				if (value === null) {
					const info = await shard.db.data.hGetAll(race.runKey(userId));
					if (info.run !== undefined) {
						await mark(shard, userId, info.room ?? '', Number(info.startedTick ?? time), undefined);
					}
				} else {
					const current = JSON.parse(value) as ActiveRun;
					// The other wrapper may already have started the new season.
					if (current.namespace === namespace && current.shard === shard.name) {
						await shard.db.data.set(activeRunKey(userId), JSON.stringify({ ...current, active: false }));
					}
				}
			});
		},
	};
}
