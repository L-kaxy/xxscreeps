import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { World } from 'xxscreeps/game/map.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import * as assert from 'node:assert/strict';
import { config } from 'xxscreeps/config/index.js';
import { acquireIntentsForRoom, updateUserRoomRelationships } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardTickProcessors } from 'xxscreeps/engine/processor/shard.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { flushUsers } from 'xxscreeps/game/room/room.js';
import { initializeSeason2Map } from './map.js';
import { readCleanup } from './respawn.js';

export function shortSeason(after = 4) {
	const previous = config.speedrunSeason2!;
	config.speedrunSeason2 = { ...previous, raceBrackets: [ 2, 4 ], respawnAfter: after };
	return { [Symbol.dispose]() { config.speedrunSeason2 = previous; } };
}

export async function editRoom(shard: Shard, world: World, name: string, edit: (room: Room) => void) {
	const room = await shard.loadRoom(name);
	runOneShot(world, room, shard.time, '', () => edit(room));
	room['#flushObjects'](null);
	const previous = flushUsers(room);
	await shard.saveRoom(name, shard.time, room);
	await shard.copyRoomFromPreviousTick(name, shard.time + 1);
	await updateUserRoomRelationships(shard, room, previous);
}

export async function scoreable(shard: Shard, world: World, name = 'E3N3', user = '100', progress = 1000) {
	await editRoom(shard, world, name, room => {
		room['#user'] = room.controller!['#user'] = user;
		room['#level'] = 3;
		room.controller!['#progress'] = progress;
		room.controller!['#downgradeTime'] = 100000;
	});
}

export async function landPlayer(shard: Shard, world: World, name = 'E3N3', user = '100') {
	const room = await shard.loadRoom(name);
	const context = new RoomProcessor(shard, world, room, shard.time);
	context.saveIntents(user, { local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] }, object: {}, internal: true });
	await context.process();
	await context.finalize(false);
	++shard.time;
	await shard.data.set('time', shard.time);
}

export async function prepareSeason(shard: Shard) {
	await initializeSeason2Map(shard, { serverStopped: true });
	const world = await shard.loadWorld();
	await landPlayer(shard, world);
	return world;
}

/** Same phase order as the real service: saved rooms, main hooks, clock advance. No player runner. */
export async function processTick(shard: Shard, world: World, extra: readonly string[] = []) {
	const job = await readCleanup(shard);
	const names = new Set([ 'E3N3', ...extra, ...job?.status === 'complete' ? [] : job?.rooms ?? [] ]);
	for (const name of names) {
		const context = new RoomProcessor(shard, world, await shard.loadRoom(name), shard.time);
		for (const payload of await acquireIntentsForRoom(shard, name)) {
			context.saveIntents(payload.userId, payload.intents);
		}
		await context.process();
		await context.finalize(false);
	}
	await runShardTickProcessors(shard, shard.time);
	++shard.time;
	await shard.data.set('time', shard.time);
}

export async function finishCleanup(shard: Shard, world: World) {
	for (let ii = 0; ii < 4 && (await readCleanup(shard))?.status !== 'complete'; ++ii) {
		await processTick(shard, world);
	}
	assert.strictEqual((await readCleanup(shard))?.status, 'complete');
}
