import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { intentProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { allowsInitialSpawn } from './rooms.js';

// Enforce the same room rule even for an internal intent which bypasses HTTP.
// Wrap season 1's chain so a refused landing cannot hand over a room or change an old race clock.
// No season-2 run, score, cleanup, special single-player lock or replacement handover is added.
const placeSpawn = intentProcessors.find(info => info.intent === 'placeSpawn' && info.receiver === Room);
if (!placeSpawn) {
	throw new Error('Season 2 requires the original placeSpawn processor');
}
const handover = placeSpawn.process;
placeSpawn.process = (room: Room, context: ProcessorContext, ...data: unknown[]) => {
	if (allowsInitialSpawn(room.name)) {
		handover(room, context, ...data);
	}
};
