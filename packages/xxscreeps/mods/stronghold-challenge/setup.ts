import type { ChallengePair } from './layout.js';
import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { schema as worldSchema } from 'xxscreeps/game/map.js';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { flushUsers } from 'xxscreeps/game/room/room.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { challengeLayout, challengeTerrain, kControllerPosition } from './layout.js';

export const pairKey = 'stronghold-challenge/pairs';
export const preparedKey = 'stronghold-challenge/prepared';
const backupKey = 'stronghold-challenge/backup';
const terrainBackupKey = 'stronghold-challenge/terrainBackup';
const roomBackupKey = 'stronghold-challenge/roomBackup';

interface BackupSlot {
	name: string;
	slot: number;
	exists: boolean;
}

interface ChallengeBackup {
	rooms: string[];
	slots: BackupSlot[];
}

export async function loadChallengePair(shard: Shard, name: string): Promise<ChallengePair | undefined> {
	const value = await shard.data.hGet(pairKey, name);
	return value === null ? undefined : JSON.parse(value) as ChallengePair;
}

/** Rebuild pristine room objects rather than retaining NPC, structure or player state. */
export function makeChallengeRoom(name: string, pair?: ChallengePair) {
	const room = new Room();
	room.name = name;
	room['#challengePair'] = pair;
	const isHome = pair?.home === name;
	room['#user'] = isHome ? null : undefined;
	room['#level'] = isHome ? 0 : -1;
	if (isHome) {
		room['#insertObject'](createRoomObject(new StructureController(), new RoomPosition(kControllerPosition.x, kControllerPosition.y, name)));
	}
	room['#flushObjects'](null);
	flushUsers(room);
	return room;
}

async function requireEmptyWorld(shard: Shard, names: Iterable<string>) {
	for (const name of names) {
		const room = await shard.loadRoom(name);
		if ((room['#user'] != null && room['#user'].length > 2) ||
			room['#objects'].some(object => object['#user'] !== null && object['#user'].length > 2)) {
			throw new Error(`Cannot prepare or restore a challenge while players are present in ${name}; respawn them first`);
		}
	}
}

async function acquireMainLease(shard: Shard) {
	if (await shard.data.pTTL('mutex/main') > 0) {
		throw new Error('Stop the running game services before preparing or restoring a stronghold challenge');
	}
	await using disposable = new AsyncDisposableStack();
	const mutex = disposable.use(await Mutex.connect('main', shard.data, shard.pubsub));
	// The preflight only rejects an existing service; acquisition still serializes a concurrent start.
	disposable.use(await mutex.acquire());
	return disposable.move();
}

/** Explicit offline preparation. Holding main also prevents services starting during the rewrite. */
export async function prepareStrongholdChallenge(shard: Shard, options: { dryRun?: boolean } = {}) {
	await using mainLock = await acquireMainLease(shard);
	await using gameMutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using gameLock = await gameMutex.acquire();
	const world = await shard.loadWorld();
	const layout = challengeLayout(world.terrain);
	await requireEmptyWorld(shard, world.terrain.keys());
	if (await shard.data.get(preparedKey) !== null) {
		throw new Error('Stronghold challenge is already prepared; restore it before preparing another map');
	}
	if (await shard.data.get(backupKey) !== null) {
		throw new Error('An unfinished challenge preparation has a backup; restore it before trying again');
	}
	if (options.dryRun) {
		return { ...layout, rooms: world.terrain.size, written: false };
	}

	// The terrain reader uses views into its blob, so preserve a copy before editing any record.
	const terrainBackup = Uint8Array.from(world.terrainBlob);
	const rooms = await shard.data.sMembers('rooms');
	const slots = await Promise.all([ ...world.terrain.keys() ].flatMap(name => [ 0, 1 ].map(async slot => {
		const blob = await shard.data.get(`room${slot}/${name}`, { blob: true });
		return { name, slot, blob: blob === null ? null : Uint8Array.from(blob) };
	})));
	await shard.data.set(terrainBackupKey, terrainBackup);
	await Promise.all(slots.filter(slot => slot.blob !== null).map(({ name, slot, blob }) =>
		shard.data.set(`${roomBackupKey}/${slot}/${name}`, blob!)));
	const backup: ChallengeBackup = { rooms, slots: slots.map(({ name, slot, blob }) => ({ name, slot, exists: blob !== null })) };
	await shard.data.set(backupKey, JSON.stringify(backup));
	// File-backed providers save blobs separately from key-value metadata. Commit the complete
	// rollback before any authored state changes, so interrupted file writes remain recoverable.
	await Promise.all([ shard.db.save(), shard.save() ]);

	const pairs = new Map(layout.pairs.flatMap(pair => [ [ pair.home, pair ], [ pair.stronghold, pair ] ] as const));
	for (const [ name, record ] of world.terrain) {
		const pair = pairs.get(name);
		world.terrain.set(name, { ...record, ...challengeTerrain(name, pair) });
		const room = makeChallengeRoom(name, pair);
		await Promise.all([ shard.saveRoom(name, shard.time, room), shard.saveRoom(name, shard.time + 1, room) ]);
	}
	await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain));
	// Every authored room remains normal; sealed terrain alone separates the arenas.
	await shard.data.sAdd('rooms', [ ...world.terrain.keys() ]);
	await shard.data.hmSet(pairKey, [ ...pairs ].map(([ name, pair ]) => [ name, JSON.stringify(pair) ]));
	await shard.save();
	// Publish readiness only after the terrain and both room buffers have reached durable storage.
	await shard.data.set(preparedKey, '1');
	await shard.save();
	return { ...layout, rooms: world.terrain.size, written: true };
}

/** Restore both room buffer slots and the open-room set, including slots that were originally absent. */
export async function restoreStrongholdChallenge(shard: Shard) {
	await using mainLock = await acquireMainLease(shard);
	await using gameMutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using gameLock = await gameMutex.acquire();
	const value = await shard.data.get(backupKey);
	if (value === null) {
		return false;
	}
	const backup = JSON.parse(value) as ChallengeBackup;
	const world = await shard.loadWorld();
	await requireEmptyWorld(shard, world.terrain.keys());
	const terrain = await shard.data.req(terrainBackupKey, { blob: true });
	// A crash while restoring must leave the challenge disabled and its rollback still present.
	await shard.data.mDel(pairKey, preparedKey);
	await Promise.all([ shard.db.save(), shard.save() ]);
	for (const { name, slot, exists } of backup.slots) {
		const key = `room${slot}/${name}`;
		if (exists) {
			await shard.data.set(key, await shard.data.req(`${roomBackupKey}/${slot}/${name}`, { blob: true }));
		} else {
			await shard.data.del(key);
		}
	}
	await shard.data.set('terrain', terrain);
	await shard.data.del('rooms');
	await shard.data.sAdd('rooms', backup.rooms);
	await shard.save();
	await shard.data.mDel(backupKey, terrainBackupKey,
		...backup.slots.map(({ name, slot }) => `${roomBackupKey}/${slot}/${name}`));
	await shard.save();
	return true;
}
