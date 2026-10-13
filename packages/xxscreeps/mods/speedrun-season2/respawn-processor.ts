import { registerIntentProcessor } from 'xxscreeps/engine/processor/index.js';
import { intentProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { me } from 'xxscreeps/game/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { withCleanup } from './cleanup-processor.js';
import { isCleanupObject, isPreservedExtractor } from './respawn.js';
import { isSeason2Room } from './rooms.js';

const unspawn = intentProcessors.find(info => info.intent === 'unspawn' && info.receiver === Room);
if (!unspawn) {
	throw new Error('Season 2 requires the original unspawn processor');
}
const handover = unspawn.process;

export type Season2RespawnIntents = [ typeof respawnIntent ];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const respawnIntent = registerIntentProcessor(Room, 'season2Respawn', { internal: true },
	(room, context, id: string) => {
		withCleanup(context, job => {
			if (job?.id !== id || job.status !== 'pending' || job.user !== me || !job.rooms.includes(room.name)) {
				return;
			}
			if (job.cleanup && isSeason2Room(room.name)) {
				for (const object of room['#objects']) {
					if (isCleanupObject(object)) {
						// No #destroy/createRuin: remove the stores with the building.
						room['#removeObject'](object);
						context.didUpdate();
					} else if (isPreservedExtractor(object) && object['#user'] === job.user) {
						// Keep the extractor itself without retaining the respawning player's ownership.
						object['#user'] = null;
						context.didUpdate();
					}
				}
				// Remove owned buildings before vanilla unspawn can turn them into ruins.
				room['#flushObjects'](context.state);
			}
			handover(room, context);
			room['#flushObjects'](context.state);
		});
	});
