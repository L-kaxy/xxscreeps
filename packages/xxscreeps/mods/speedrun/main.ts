import { config } from 'xxscreeps/config/index.js';
import { registerShardInitializer } from 'xxscreeps/engine/processor/index.js';
import { roomsToClose } from './rooms.js';

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
