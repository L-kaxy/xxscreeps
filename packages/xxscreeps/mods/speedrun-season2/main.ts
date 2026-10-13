import { registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { captureDueBrackets, raceBrackets } from './race.js';
import { advanceCleanup } from './respawn.js';

// Runs after room processing, including while the player is offline. No map initializer or
// resetExpiredRuns here: only a manually requested cleanup may be resumed.
registerShardTickProcessor(async (shard, time) => {
	await advanceCleanup(shard, time);
	if (raceBrackets().length !== 0) {
		await captureDueBrackets(shard, time);
	}
});
