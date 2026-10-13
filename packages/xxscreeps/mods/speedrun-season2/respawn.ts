import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { RoomObject } from 'xxscreeps/game/object.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { randomUUID } from 'node:crypto';
import { config } from 'xxscreeps/config/index.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { ConstructionSite } from 'xxscreeps/mods/classic/construction/construction-site.js';
import { registerRespawnInterceptor } from 'xxscreeps/mods/classic/spawn/model.js';
import { Ruin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { Structure } from 'xxscreeps/mods/classic/structure/structure.js';
import { saveUserFlagBlobForNextTick } from 'xxscreeps/mods/meta/flag/model.js';
import { activeRunKey } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import * as C from 'xxscreeps:mods/constants';
import { stopRun } from './race.js';
import { isSeason2Room, season2SpawnRoom } from './rooms.js';

export const cleanupKey = 'speedrun-season2/cleanup';
export const cleanupSpawnError = 'Season 2 respawn cleanup is still pending';

export interface CleanupJob {
	id: string;
	user: string;
	requestedTick: number;
	status: 'preparing' | 'pending' | 'complete';
	cleanup: boolean;
	rooms: string[];
	block: string[];
	finishedTick?: number;
}

// Explicit player-buildable types, not "everything with hits" or "every Structure".
// Central-nine extractors are the explicit exception; extractor construction sites are not.
const artificialTypes = new Set<string>([
	C.STRUCTURE_SPAWN, C.STRUCTURE_EXTENSION, C.STRUCTURE_ROAD, C.STRUCTURE_WALL,
	C.STRUCTURE_RAMPART, C.STRUCTURE_LINK, C.STRUCTURE_STORAGE, C.STRUCTURE_TOWER,
	C.STRUCTURE_OBSERVER, C.STRUCTURE_POWER_SPAWN, C.STRUCTURE_EXTRACTOR, C.STRUCTURE_LAB,
	C.STRUCTURE_TERMINAL, C.STRUCTURE_CONTAINER, C.STRUCTURE_NUKER, C.STRUCTURE_FACTORY,
]);

export function isCleanupObject(object: RoomObject) {
	if (isPreservedExtractor(object)) {
		return false;
	}
	return object instanceof ConstructionSite || object instanceof Ruin ||
		(object instanceof Structure && artificialTypes.has(object.structureType));
}

export function isPreservedExtractor(object: RoomObject) {
	return object instanceof Structure && object.structureType === C.STRUCTURE_EXTRACTOR &&
		/^E[4-6]N[4-6]$/.test(object.pos.roomName);
}

export async function readCleanup(shard: Shard): Promise<CleanupJob | undefined> {
	const value = await shard.data.get(cleanupKey);
	return value === null ? undefined : JSON.parse(value) as CleanupJob;
}

/** Held through the synchronous processor mutation, not just through the preceding DB read. */
export async function acquireCleanup(shard: Shard) {
	const disposable = new AsyncDisposableStack();
	try {
		const mutex = disposable.use(await Mutex.connect(cleanupKey, shard.data, shard.pubsub));
		disposable.use(await mutex.acquire());
		const job = await readCleanup(shard);
		return { job, [Symbol.asyncDispose]: () => disposable.disposeAsync() };
	} catch (error) {
		await disposable.disposeAsync();
		throw error;
	}
}

export function blocksSpawn(job: CleanupJob | undefined, user: string, room: string) {
	return job !== undefined && job.status !== 'complete' && (job.user === user || isSeason2Room(room));
}

export function isCleanRoom(room: Room, job: CleanupJob) {
	return room['#user'] !== job.user && !room['#objects'].some(object =>
		object['#user'] === job.user || (job.cleanup && isSeason2Room(room.name) && isCleanupObject(object)));
}

async function queueRoom(shard: Shard, job: CleanupJob, room: string) {
	await pushIntentsForRoomNextTick(shard, room, job.user, {
		local: { season2Respawn: [ [ job.id ] ] },
		internal: true,
	});
}

/**
 * Verify every target's persisted current buffer on a tick after the request, not the processor's
 * in-memory room or its not-yet-current next buffer. Lost scratch queues are rebuilt after restart.
 * This needs no engine save hook or per-room acknowledgment.
 */
export async function advanceCleanup(shard: Shard, time: number) {
	const initial = await readCleanup(shard);
	if (initial?.status === undefined || initial.status === 'complete') {
		return;
	}
	// Outside the block mutex: the race adapter has its own account-level lock.
	await stopRun(shard, initial.user, initial.requestedTick);
	await using handle = await acquireCleanup(shard);
	const job = handle.job;
	if (job?.id !== initial.id || job.status === 'complete') {
		return;
	}
	const remaining: string[] = [];
	for (const name of job.rooms) {
		// At the request tick, queue (or recover) all targets and keep the gate closed.
		// Main runs after finalize, but the just-saved next buffer is not current until tick advance.
		if (time <= job.requestedTick || !isCleanRoom(await shard.loadRoom(name, time), job)) {
			remaining.push(name);
		}
	}
	// Recover the common respawn's flag clearing even if its process died before reaching that call.
	await saveUserFlagBlobForNextTick(shard, job.user, undefined);
	if (remaining.length === 0) {
		await shard.data.set(cleanupKey, JSON.stringify({ ...job, status: 'complete', finishedTick: time }));
		return;
	}
	await shard.data.set(cleanupKey, JSON.stringify({ ...job, status: 'pending' }));
	await Promise.all(remaining.map(name => queueRoom(shard, job, name)));
}

registerRespawnInterceptor(async (shard, user, rooms) => {
	let job: CleanupJob | undefined;
	{
		await using handle = await acquireCleanup(shard);
		const previous = handle.job;
		if (previous && previous.status !== 'complete') {
			// Repeated button presses reuse the same generation. Another player's ordinary respawn
			// must not replace a cleanup already in flight.
			if (previous.user !== user) {
				return undefined;
			}
			job = previous;
		} else {
			const currentValue = await shard.db.data.get(activeRunKey(user));
			const current = currentValue === null ? undefined : JSON.parse(currentValue) as {
				namespace: string; shard: string; active: boolean;
			};
			// A current old-season run never triggers new-season clearing.
			if (current?.active && (current.namespace !== 'speedrun-season2' || current.shard !== shard.name)) {
				return undefined;
			}
			const world = await shard.loadWorld();
			const landing = world.terrain.has(season2SpawnRoom) ? await shard.loadRoom(season2SpawnRoom) : undefined;
			const inSeason = current?.active && current.namespace === 'speedrun-season2' && current.shard === shard.name;
			if (!inSeason && landing?.['#user'] !== user) {
				return undefined;
			}
			const block = [ ...world.terrain.keys() ].filter(isSeason2Room).sort();
			const cleanup = config.speedrunSeason2?.respawnCleanup !== false;
			const targets = [ ...new Set([ ...rooms, ...landing ? [ season2SpawnRoom ] : [], ...cleanup ? block : [] ]) ];
			job = { id: randomUUID(), user, requestedTick: shard.time, status: 'preparing', cleanup, rooms: targets, block };
			await shard.data.set(cleanupKey, JSON.stringify(job));
			if (previous) {
				// Earlier step-10 builds used a save-hook acknowledgment hash; it is no longer read.
				await shard.data.vDel(`speedrun-season2/cleanup-acks/${previous.id}`);
			}
		}
	}
	// Persist the gate before stopping the clock or queueing any destructive work.
	await stopRun(shard, user, job.requestedTick);
	{
		await using handle = await acquireCleanup(shard);
		if (handle.job?.id === job.id && handle.job.status !== 'complete') {
			await shard.data.set(cleanupKey, JSON.stringify({ ...job, status: 'pending' }));
			await Promise.all(job.rooms.map(name => queueRoom(shard, job, name)));
		}
	}
	return job.rooms;
});
