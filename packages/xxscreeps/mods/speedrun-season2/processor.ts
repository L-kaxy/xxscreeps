import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { config } from 'xxscreeps/config/index.js';
import { intentProcessors, roomTickProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { allowsInitialSpawn, isSeason2Room } from './rooms.js';

// Run before the vanilla periodic raid generator, including on the first tick after deployment.
// Leave its target, existing NPCs, Source Keepers and the manual requestInvader intent untouched.
// Season 1 has its own disjoint hook; neither switch falls back to the other season.
roomTickProcessors.unshift((room, context) => {
	if (isSeason2Room(room.name) && config.speedrunSeason2?.invaders === false && room['#cumulativeEnergyHarvested'] !== 0) {
		room['#cumulativeEnergyHarvested'] = 0;
		context.didUpdate();
	}
});

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
