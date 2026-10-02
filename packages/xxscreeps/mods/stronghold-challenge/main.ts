import { mods } from 'xxscreeps/config/mods.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { registerShardTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { resetExpiredRuns } from './race.js';
import { guardPreparedMain, isMainServiceEntry } from './startup.js';

if (mods.some(mod => mod.url.endsWith('/mods/speedrun/index.js'))) {
	throw new Error('Enable either speedrun or stronghold-challenge on a shard');
}

// The main provider also loads in test fixtures. Install only for the actual service entry;
// prepare-stronghold must be able to acquire the same lock before the map is ready.
if (isMainServiceEntry(process.argv[1])) {
	const connect = Mutex.connect.bind(Mutex);
	Mutex.connect = async (name, data, pubsub) => {
		const mutex = await connect(name, data, pubsub);
		return name === 'main' ? guardPreparedMain(mutex, data) : mutex;
	};
}

registerShardTickProcessor(resetExpiredRuns);
