import { registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { captureDueBrackets, raceBrackets } from './race.js';

// Runs after room processing, including while the player is offline. No map initializer or
// resetExpiredRuns here: automatic handover and full-block cleanup belong to later steps.
registerShardTickProcessor(async (shard, time) => {
	if (raceBrackets().length !== 0) {
		await captureDueBrackets(shard, time);
	}
});
