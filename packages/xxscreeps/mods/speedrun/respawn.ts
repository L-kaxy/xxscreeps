import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import type { RoomObject } from 'xxscreeps/game/object.js';
import { config } from 'xxscreeps/config/index.js';
import { intentProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { me } from 'xxscreeps/game/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureWall } from 'xxscreeps/mods/classic/defense/wall.js';
import { StructureContainer } from 'xxscreeps/mods/classic/resource/container.js';
import { StructureRoad } from 'xxscreeps/mods/classic/road/road.js';

// A respawn hands a player's rooms back to the world (`mods/classic/spawn/processor.ts:93-108`):
// every object the leaving player owns is taken out of the room and the controller is released. The
// structures they built which nobody owns -- a road, a container, a wall -- carry no `#user`, so
// that handler never looks at them: a container does not decay, and it is still standing in the
// room long after the base which built it is gone. This rule clears them out in the same tick.
//
// The room list needs no work of its own. The respawn route reads the *presence* room set
// (`mods/classic/spawn/backend.ts:192`) and pushes one `unspawn` intent per room, and presence is
// exactly "this player had something here" (`game/room/room.ts:298-321`): the rooms they own, the
// rooms they reserved -- `ControllerProc.reserve` writes the reserver into `room['#user']`
// (`controller/processor.ts:36-42` with `controller.ts:220-222`) -- and the rooms their creeps
// stood in.
//
// The handler is wrapped rather than shadowed. The room stage only ever calls the *first*
// registration whose receiver matches (`engine/processor/room.ts:212-217`), so registering a second
// `unspawn` would replace the handover instead of adding to it. `process` is a plain writable field
// (`engine/processor/index.ts:21-33`) which the stage reads as it dispatches, so chaining keeps the
// vanilla handover intact -- `mods/modern/stronghold` wraps `Structure.prototype` the same way. The
// wrap runs *before* the handover, which is what lets it see the creeps of the leaving player.
//
// The switch is read per respawn so a test can flip it inside a running process; the value in
// `.screepsrc.yaml` is read while a service boots, so an operator flipping that one still needs a
// restart. Tombstones, ruins and the world's own neutral structures (power banks and the like) are
// not on the list below and are never touched.

/** The neutral structures a player can actually put down. Everything else neutral is world content. */
function isClearable(object: RoomObject) {
	return object['#user'] === null &&
		(object instanceof StructureRoad ||
			object instanceof StructureContainer ||
			object instanceof StructureWall);
}

/**
 * Whether the leftovers of this room belong to the leaving player. A room they were holding -- owned
 * or reserved, both of which the engine records in `room['#user']` -- counts outright. Anywhere else
 * they only had creeps: those count while nobody else is standing in the room, so a room which is
 * being fought over, or worked by another player, is left alone.
 */
function wasUsing(room: Room, userId: string) {
	if (room['#user'] === userId) {
		return true;
	}
	let mine = false;
	let theirs = false;
	for (const object of room['#objects']) {
		if (object instanceof Creep) {
			if (object['#user'] === userId) {
				mine = true;
			} else {
				theirs = true;
			}
		}
	}
	return mine && !theirs;
}

function clearLeftovers(room: Room, context: ProcessorContext) {
	const userId = me;
	if (!wasUsing(room, userId)) {
		return;
	}
	let didClear = false;
	for (const object of room['#objects']) {
		if (isClearable(object)) {
			object['#destroy']();
			didClear = true;
		}
	}
	if (didClear) {
		context.didUpdate();
	}
}

const unspawn = intentProcessors.find(info => info.intent === 'unspawn' && info.receiver === Room);
if (unspawn) {
	const handover = unspawn.process;
	unspawn.process = (room: Room, context: ProcessorContext, ...data: unknown[]) => {
		if (config.speedrun?.respawnCleanup !== false) {
			clearLeftovers(room, context);
		}
		handover(room, context, ...data);
	};
}
