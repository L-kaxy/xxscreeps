import { registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { captureDueBrackets, raceBrackets } from './race.js';
import { advanceCleanup } from './respawn.js';
import { resetExpiredRuns } from './restart.js';

// Runs after room processing, including while the player is offline. A pending manual cleanup
// ends its clock first; otherwise final scores must land before an automatic cleanup is reserved.
registerShardTickProcessor(async (shard, time) => {
	await advanceCleanup(shard, time);
	if (raceBrackets().length !== 0) {
		await captureDueBrackets(shard, time);
		await resetExpiredRuns(shard, time);
	}
});
