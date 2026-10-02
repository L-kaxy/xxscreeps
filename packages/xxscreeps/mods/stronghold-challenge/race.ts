import type { ChallengeRun } from './run-schema.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { KeyvalScript } from 'xxscreeps/engine/db/storage/script.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { hooks } from 'xxscreeps/mods/classic/spawn/hooks.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import { challengeRankingKeys } from './ranking.js';
import { writeRankedRun } from './runs.js';

export const activeKey = 'stronghold-challenge/active';
export const dueKey = 'stronghold-challenge/due';
export const runKey = (userId: string) => `stronghold-challenge/run/${userId}`;

const ReserveLanding = new KeyvalScript((data, [ key, due ]: [ string, string ], [ runId, tick, home, targetRoom ]: [ string, number, string, string ]) => {
	const previous = data.hGetAll(key);
	if (Number(previous.startedTick ?? -1) >= tick && previous.runId !== runId) {
		return null;
	}
	if (previous.runId !== undefined && previous.runId !== runId) {
		data.zRem(due, [ String(previous.runId) ]);
	}
	if (previous.runId !== runId) {
		data.del(key);
		data.hmSet(key, { runId, startedTick: String(tick), room: home, targetRoom, state: 'preparing', revision: '-1' });
	}
	return JSON.stringify(previous);
}, { lua:
`local values = redis.call('hgetall', KEYS[1])
local previous = {}
for ii = 1, #values, 2 do previous[values[ii]] = values[ii + 1] end
if tonumber(previous.startedTick or '-1') >= tonumber(ARGV[2]) and previous.runId ~= ARGV[1] then return nil end
if previous.runId and previous.runId ~= ARGV[1] then redis.call('zrem', KEYS[2], previous.runId) end
if previous.runId ~= ARGV[1] then
	redis.call('del', KEYS[1])
	redis.call('hset', KEYS[1], 'runId', ARGV[1], 'startedTick', ARGV[2], 'room', ARGV[3], 'targetRoom', ARGV[4], 'state', 'preparing', 'revision', '-1')
end
return cjson.encode(previous)` });

export async function reserveLanding(shard: Shard, userId: string, runId: string, tick: number, home: string, targetRoom: string): Promise<Record<string, string> | undefined> {
	const previous = await shard.data.eval(ReserveLanding, [ runKey(userId), dueKey ], [ runId, tick, home, targetRoom ]);
	return previous === null ? undefined : JSON.parse(previous) as Record<string, string>;
}

// Room processors own the state. The projection is atomic, so an old pair finishing its reset
// cannot overwrite a newer landing or remove the new run from the live board.
const ProjectRun = new KeyvalScript((data, [ key, active, due ]: [ string, string, string ], [ userId, json ]: [ string, string ]) => {
	const fields = JSON.parse(json) as Record<string, string>;
	const previousTick = Number(data.hGet(key, 'startedTick') ?? -1);
	const previousRevision = Number(data.hGet(key, 'revision') ?? -1);
	const tick = Number(fields.startedTick);
	if (previousTick > tick || (previousTick === tick && (
		data.hGet(key, 'runId') !== fields.runId || previousRevision > Number(fields.revision)))) {
		return 0;
	}
	data.del(key);
	data.hmSet(key, fields);
	if (fields.state === 'running' || fields.state === 'won') {
		data.sAdd(active, [ userId ]);
		data.zAdd(due, [ [ Number(fields.deadlineTick), fields.runId! ] ]);
	} else {
		data.sRem(active, [ userId ]);
		if (fields.state === 'abandoned') {
			data.zRem(due, [ fields.runId! ]);
		}
	}
	return 1;
}, { lua:
`local fields = cjson.decode(ARGV[2])
local previousTick = tonumber(redis.call('hget', KEYS[1], 'startedTick') or '-1')
local previousRevision = tonumber(redis.call('hget', KEYS[1], 'revision') or '-1')
local tick = tonumber(fields.startedTick)
if previousTick > tick or (previousTick == tick and (redis.call('hget', KEYS[1], 'runId') ~= fields.runId or previousRevision > tonumber(fields.revision))) then
	return 0
end
redis.call('del', KEYS[1])
for key, value in pairs(fields) do redis.call('hset', KEYS[1], key, value) end
if fields.state == 'running' or fields.state == 'won' then
	redis.call('sadd', KEYS[2], ARGV[1])
	redis.call('zadd', KEYS[3], fields.deadlineTick, fields.runId)
else
	redis.call('srem', KEYS[2], ARGV[1])
	if fields.state == 'abandoned' then redis.call('zrem', KEYS[3], fields.runId) end
end
return 1` });

export function publishRun(shard: Shard, targetRoom: string, run: ChallengeRun) {
	const revision = { running: 0, won: 1, timedOut: 2, abandoned: 3 }[run.state];
	const fields = {
		coreId: run.coreId,
		deadlineTick: String(run.deadlineTick),
		finishedTick: String(run.finishedTick ?? ''),
		revision: String(revision),
		room: run.home,
		run: String(run.startedTick),
		runId: run.runId,
		startedTick: String(run.startedTick),
		state: run.state,
		targetRoom,
		user: run.userId,
	};
	return shard.data.eval(ProjectRun, [ runKey(run.userId), activeKey, dueKey ], [ run.userId, JSON.stringify(fields) ]);
}

export async function recordVictory(shard: Shard, targetRoom: string, run: ChallengeRun) {
	if (run.state !== 'won' || run.finishedTick === undefined || run.finishedTick >= run.deadlineTick) {
		throw new Error('Only a core defeated before expiry can enter the challenge leaderboard');
	}
	const elapsed = run.finishedTick - run.startedTick;
	await writeRankedRun(shard.db.data, challengeRankingKeys(shard.name), 'ascending', {
		user: run.userId, runId: run.runId, score: elapsed,
		fields: {
			user: run.userId, runId: run.runId, elapsed: String(elapsed),
			room: run.home, targetRoom, startedTick: String(run.startedTick),
			finishedTick: String(run.finishedTick), at: String(Date.now()),
		},
	});
	await publishRun(shard, targetRoom, run);
}

hooks.register('extraRespawnRooms', async (shard, userId) => {
	const run = await shard.data.hGetAll(runKey(userId));
	return run.room === undefined || run.targetRoom === undefined ? [] : [ run.room, run.targetRoom ];
});

hooks.register('didRequestRespawn', async (shard, userId) => {
	const run = await shard.data.hGetAll(runKey(userId));
	if (run.runId !== undefined && run.room !== undefined && run.targetRoom !== undefined) {
		await Promise.all([
			pushIntentsForRoomNextTick(shard, run.targetRoom, userId, {
				internal: true, local: { resetStrongholdChallenge: [ [ run.runId ] ] },
			}),
			pushIntentsForRoomNextTick(shard, run.room, userId, {
				internal: true, local: { resetStrongholdHome: [ [ run.runId ] ] },
			}),
		]);
	}
});

/** Runs after all rooms have saved the tick, so a new landing has superseded its old deadline. */
export async function resetExpiredRuns(shard: Shard, time: number) {
	const due = await shard.data.zRange(dueKey, -Infinity, time + 1, { by: 'SCORE' });
	for (const runId of due) {
		const userId = runId.slice(0, runId.indexOf(':'));
		const fields = await shard.data.hGetAll(runKey(userId));
		if (fields.runId === runId && fields.state !== 'abandoned') {
			await respawnPlayer(shard, userId, [ fields.room!, fields.targetRoom! ]);
		}
		await shard.data.zRem(dueKey, [ runId ]);
	}
}
