import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { userToPresenceRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { isCurrentSeasonRun } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import { dueRunsKey, hasNewerSeason2Run, raceBrackets, racingKey, runKey, withRunLock } from './race.js';
import { acquireCleanup, advanceCleanup, reserveCleanup } from './respawn.js';
import { isSeason2Room } from './rooms.js';

const resetting = new WeakMap<Shard, { time: number; task: Promise<void> }>();

/** Coalesce duplicate local polls; the database locks still coordinate separate processes. */
export async function resetExpiredRuns(shard: Shard, time: number) {
	const previous = resetting.get(shard);
	if (previous) {
		await previous.task;
		if (time <= previous.time) {
			return;
		}
		return resetExpiredRuns(shard, time);
	}
	const task = resetExpired(shard, time);
	resetting.set(shard, { time, task });
	try {
		await task;
	} finally {
		resetting.delete(shard);
	}
}

/** A durable reservation replaces the core's repeated global respawn and its fifty-tick retry loop. */
async function resetExpired(shard: Shard, time: number) {
	const after = config.speedrunSeason2?.respawnAfter ?? Math.max(0, ...raceBrackets());
	if (after <= 0 || raceBrackets().length === 0) {
		return;
	}
	const expired = await shard.data.zRange(racingKey, -Infinity, time - after, { by: 'SCORE' });
	for (const member of expired) {
		try {
			await reserveExpiredRun(shard, member, time, after);
			await advanceCleanup(shard, time);
		} catch (error) {
			// Keep the run or its persisted preparing job. The next tick/restart can finish the request.
			console.error(`speedrun-season2: restart ${member} failed; retaining it for retry`, error);
		}
	}
}

async function reserveExpiredRun(shard: Shard, member: string, time: number, after: number) {
	const [ user, run ] = member.split(':');
	if (user === undefined || user === '' || run === undefined || run === '') {
		await shard.data.zRem(racingKey, [ member ]);
		return;
	}
	// Same order as classic's automatic respawn: account first, block second. Never call the
	// locking race adapter/respawnPlayer inside this section: the gate is enough to reserve cleanup.
	await withRunLock(shard, user, async () => {
		await using handle = await acquireCleanup(shard);
		if (handle.job && handle.job.status !== 'complete') {
			return;
		}
		const info = await shard.db.data.hGetAll(runKey(user));
		if (info.run !== run || !isSeason2Room(info.room) || info.endedTick !== undefined ||
			!await isCurrentSeasonRun(shard, 'speedrun-season2', user, info) ||
			await shard.db.data.hGet(User.infoKey(user), 'username') === null) {
			await shard.data.zRem(racingKey, [ member ]);
			return;
		}
		// Do not trust an old sorted-set score to decide the age of the current run.
		if (!Number.isFinite(Number(info.startedTick)) || time - Number(info.startedTick) < after) {
			return;
		}
		const controlled = await shard.scratch.sMembers(controlledRoomsKey(user));
		if (controlled.some(name => !isSeason2Room(name))) {
			await shard.data.zRem(racingKey, [ member ]);
			return;
		}
		const room = await shard.loadRoom(info.room!);
		if (room['#user'] !== null && room['#user'] !== user) {
			// Another player can land after this player loses everything, before the old timer expires.
			await shard.data.zRem(racingKey, [ member ]);
			return;
		}
		// A successful new landing is recorded before its next room buffer becomes current. Check
		// durable clocks too, rather than trusting only the still-unowned current room buffer.
		if (await hasNewerSeason2Run(shard, user, Number(info.startedTick))) {
			await shard.data.zRem(racingKey, [ member ]);
			return;
		}
		const due = await shard.data.zRange(dueRunsKey, -Infinity, time, { by: 'SCORE' });
		if (due.some(value => value.startsWith(`${member}:`))) {
			// The final capture failed. Do not delete the room before it can be retried.
			return;
		}
		const presence = await shard.scratch.sMembers(userToPresenceRoomsSetKey(user));
		await reserveCleanup(shard, user, [ ...presence, ...controlled, info.room! ], time, {
			run, room: info.room!, startedTick: info.startedTick!,
		});
	});
}
