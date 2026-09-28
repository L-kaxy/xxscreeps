import { config } from 'xxscreeps/config/index.js';
import { registerShardInitializer, registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { schema as worldSchema } from 'xxscreeps/game/map.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { captureDueBrackets, raceBrackets } from './race.js';
import { roomsToClose, sectorCoreRooms } from './rooms.js';
import { isSolid, wallSectorCores } from './walls.js';

// Closing a room is xxscreeps' equivalent of the vanilla server's `closeRoom` console command: the
// room is dropped from the world's open-room list -- `shard.data`'s `'rooms'` set -- and every
// reader of that set reports it as `{ status: 'closed' }` (the value the vanilla server stores as
// `'out of borders'` and exposes to players as `closed`). Nothing inside the room is read, moved or
// deleted: the room blob, its objects and its terrain are left exactly as they are, and rooms which
// aren't part of a sector core are never touched. Reopening is the same operation in reverse, i.e.
// `sAdd('rooms', [ name ])`.
//
// Which rooms are closed comes from the world's own sector records (see `rooms.ts`). Seeding here --
// once, when the shard's services start and before the first tick -- rather than behind a per-tick
// "already closed?" check keeps the steady-state tick free of extra I/O, and re-closes a world which
// `xxscreeps import` re-opened (the import script adds every room back to the set) on the next start.
registerShardInitializer(async shard => {
	if (config.speedrun?.closeCenterNine !== true) {
		return;
	}
	const [ world, open ] = await Promise.all([ shard.loadWorld(), shard.data.sMembers('rooms') ]);
	const closing = roomsToClose(world.terrain, open);
	if (closing.length !== 0) {
		await shard.data.sRem('rooms', closing);
		console.log(`speedrun: closed ${closing.length} of ${open.length} rooms: ${closing.join(' ')}`);
	}
});

// A closed room is still a room: it ticks, and a creep which walks up to its border is handed across
// like anywhere else. Painting the core solid is what turns the closure into something a player can
// see and which holds -- every tile of the nine core rooms becomes wall, and so does the facing edge
// of each room around them, which is the step that actually has to be refused. `walls.ts` has the
// mechanism and the reason the neighbours have to be sealed too.
//
// Terrain is the only thing written: every object in those rooms stays in storage, no room blob is
// rewritten, and the sector record on the center room survives -- which is what keeps deposit and
// power bank placement working, since both find their highway rooms by walking those records. The
// original terrain blob is put aside under `speedrun/terrainBackup` before the first rewrite, so the
// wall can be lifted by writing it back.
//
// Services read the world blob while they boot and this runs after that, so a wall written here takes
// effect across the shard on the *next* start. A start which finds an already-solid core writes
// nothing at all.
registerShardInitializer(async shard => {
	if (config.speedrun?.wallSectorCores === false) {
		return;
	}
	const world = await shard.loadWorld();
	const core = sectorCoreRooms(world.terrain);
	if (core.length === 0 || isSolid(world.terrain, core)) {
		return;
	}
	const touched = wallSectorCores(world.terrain, core);
	await Promise.all([
		// Rollback material, written once and never overwritten.
		(async () => {
			if (await shard.data.get('speedrun/terrainBackup', { blob: true }) === null) {
				await shard.data.set('speedrun/terrainBackup', world.terrainBlob);
			}
		})(),
		shard.data.set('terrain', makeWriter(worldSchema)(world.terrain)),
	]);
	console.log(`speedrun: walled ${core.length} core rooms and sealed ${touched.length - core.length} rooms around them`);
});

// Race results are captured from the shard tick processor, which the shard service runs once the
// tick's rooms have all been processed (`engine/service/main.ts:132-133`). That is what makes a result
// land at the right tick whether or not the player is online: the room blob is read straight out of
// storage, and a room which went to sleep keeps the state it had. The schedule lives in `shard.data`
// rather than scratch because it has to survive across ticks -- see `race.ts` for the tables written.
registerShardTickProcessor(async (shard, time) => {
	if (raceBrackets().length !== 0) {
		await captureDueBrackets(shard, time);
	}
});
