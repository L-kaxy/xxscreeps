import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { makeHookRegistration } from 'xxscreeps/utility/hook.js';

export const hooks = makeHookRegistration<{
	/** Additional rooms a respawn must visit, even when the player has no current presence there. */
	extraRespawnRooms: (shard: Shard, userId: string) => readonly string[] | Promise<readonly string[]>;
	/** A respawn request whose room intents and flag clear have all been successfully queued. */
	didRequestRespawn: (shard: Shard, userId: string) => void | Promise<void>;
}>();
