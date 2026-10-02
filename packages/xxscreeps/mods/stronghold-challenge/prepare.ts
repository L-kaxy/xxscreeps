import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { mods } from 'xxscreeps/config/mods.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { isSiblingProcess } from 'xxscreeps/engine/db/storage/local/responder.js';
import { prepareStrongholdChallenge, restoreStrongholdChallenge } from 'xxscreeps/mods/stronghold-challenge/setup.js';

async function main() {
	const argv = checkArguments({ argv: true, boolean: [ 'dry-run', 'restore' ] as const, string: [ 'shard' ] as const });
	if (argv.argv.length !== 0 || (argv.restore && argv['dry-run'])) {
		console.log('Usage: xxscreeps prepare-stronghold [--shard shard] [--dry-run | --restore]');
		process.exitCode = 1;
		return;
	}
	if (!mods.some(mod => mod.url.endsWith('/mods/stronghold-challenge/index.js'))) {
		throw new Error('Enable xxscreeps/mods/stronghold-challenge before preparing its map');
	}
	if (mods.some(mod => mod.url.endsWith('/mods/speedrun/index.js'))) {
		throw new Error('Enable either speedrun or stronghold-challenge on a shard');
	}
	// A sibling shares a live local storage host; acquiring game alone would not invalidate its rooms.
	if (await isSiblingProcess()) {
		throw new Error('Stop all server services before preparing or restoring the stronghold map');
	}
	await using db = await Database.connect();
	await using shard = await Shard.connect(db, argv.shard ?? config.shards[0]!.name);
	if (argv.restore) {
		console.log(await restoreStrongholdChallenge(shard) ? 'Restored the world from before challenge preparation' : 'No stronghold challenge backup to restore');
	} else {
		const report = await prepareStrongholdChallenge(shard, { dryRun: argv['dry-run'] });
		console.log(`${report.written ? 'Prepared' : 'Would prepare'} ${report.pairs.length} pairs, ${report.unused.length} unused interior rooms, ${report.rooms} rooms in the world`);
	}
}

if (process.argv[1] === 'prepare-stronghold') {
	await main();
}
