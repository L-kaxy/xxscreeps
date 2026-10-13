import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { config } from 'xxscreeps/config/index.js';
import { intentProcessors, roomTickProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Game, me } from 'xxscreeps/game/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { withCleanup } from './cleanup-processor.js';
import { startRun, stopRun } from './race.js';
import { blocksSpawn } from './respawn.js';
import { allowsInitialSpawn, isSeason2Room } from './rooms.js';
import './respawn-processor.js';

export type { Season2RespawnIntents } from './respawn-processor.js';

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
// Hold the cleanup gate through handover, including internal intents which bypass HTTP.
const placeSpawn = intentProcessors.find(info => info.intent === 'placeSpawn' && info.receiver === Room);
if (!placeSpawn) {
	throw new Error('Season 2 requires the original placeSpawn processor');
}
const handover = placeSpawn.process;
placeSpawn.process = (room: Room, context: ProcessorContext, ...data: unknown[]) => {
	if (allowsInitialSpawn(room.name)) {
		withCleanup(context, job => {
			if (blocksSpawn(job, me, room.name)) {
				return;
			}
			const wasUnowned = room['#user'] === null;
			handover(room, context, ...data);
			// These handovers now run in an async-task finalizer, after the engine's regular flush.
			room['#flushObjects'](context.state);
			if (wasUnowned && room['#user'] === me) {
				if (isSeason2Room(room.name)) {
					context.task(startRun(context.shard, me, room.name, Game.time));
				} else {
					context.task(stopRun(context.shard, me, Game.time));
				}
			}
		});
	}
};
