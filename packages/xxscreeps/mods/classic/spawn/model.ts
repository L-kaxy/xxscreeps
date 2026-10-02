import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { pushIntentsForRoomNextTick, userToPresenceRoomsSetKey } from 'xxscreeps/engine/processor/model.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { saveUserFlagBlobForNextTick } from 'xxscreeps/mods/meta/flag/model.js';
import { hooks } from './hooks.js';

const extraRespawnRooms = hooks.makeMapped('extraRespawnRooms');
const didRequestRespawn = hooks.makeMapped('didRequestRespawn');

/**
 * Hand everything a player holds over: one `unspawn` intent per room, queued for the next tick, and
 * their flags cleared. This is the respawn, and this is the only implementation of it -- the
 * `/api/user/respawn` route calls it, and so does anything which restarts a player on its own, so a
 * restart a server decides on cannot drift from the button a player presses.
 *
 * Returns the rooms it went to, so a caller can tell whether there was anything of theirs to hand
 * over: an empty list means there was not.
 *
 * The rooms are the ones the player is present in, the ones they control, and any the caller names.
 * Presence is the set the route has always used, and it lives in scratch: a player who is not around
 * can be missing from it, and a handover which goes to no room at all is a restart which never
 * happened. A room named by the caller is the one there always is a name for, and `unspawn` ignores a
 * room which holds nothing of theirs, so naming one costs a no-op.
 */
export async function respawnPlayer(shard: Shard, userId: string, extraRooms: readonly string[] = []) {
	const [ presence, controlled, contributed ] = await Promise.all([
		shard.scratch.sMembers(userToPresenceRoomsSetKey(userId)),
		shard.scratch.sMembers(controlledRoomsKey(userId)),
		Promise.all(Fn.map(extraRespawnRooms(shard, userId), rooms => Promise.resolve(rooms))),
	]);
	const rooms = [ ...new Set([ ...presence, ...controlled, ...extraRooms, ...contributed.flat() ]) ];
	await Promise.all([
		...rooms.map(roomName => pushIntentsForRoomNextTick(shard, roomName, userId, {
			local: { unspawn: [ [] ] },
			internal: true,
		})),
		// The flags go with the rooms: a respawn leaves nothing behind.
		saveUserFlagBlobForNextTick(shard, userId, undefined),
	]);
	await Promise.all(Fn.map(didRequestRespawn(shard, userId), result => Promise.resolve(result)));
	return rooms;
}
