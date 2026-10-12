import type { HighwayReport, MapReport } from 'xxscreeps/mods/speedrun-season2/map.js';
import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { initializeSeason2Map, previewHighwaySealing, previewSeason2Map, restoreSeason2Map, sealSeason2Highways } from 'xxscreeps/mods/speedrun-season2/map.js';

// No service provider imports this command. No action flag means a read-only preview.
async function main() {
	const argv = checkArguments({
		argv: true,
		boolean: [ 'dry-run', 'initialize', 'restore', 'seal-highways', 'server-stopped' ] as const,
		string: [ 'shard' ] as const,
	});
	if (argv.argv.length !== 0 || [ argv.initialize, argv.restore, argv['seal-highways'] ].filter(Boolean).length > 1
		|| (argv['dry-run'] && (argv.initialize || argv.restore))) {
		throw new Error('Usage: xxscreeps season2-map [--shard name] [--initialize | --restore | --seal-highways [--dry-run]] [--server-stopped]');
	}
	if (config.speedrunSeason2 === undefined) {
		throw new Error('Enable xxscreeps/mods/speedrun-season2 before using season2-map');
	}
	const write = argv.initialize || argv.restore || (argv['seal-highways'] && !argv['dry-run']);
	if (write && !argv['server-stopped']) {
		throw new Error('Stop all services first, then explicitly pass --server-stopped');
	}
	await using db = await Database.connect();
	await using shard = await Shard.connect(db, argv.shard ?? config.shards[0]!.name);
	if (write) {
		const localData = !/^redis[s]?:/.test(config.shards.find(info => info.name === shard.name)!.data);
		if (localData) {
			const { isSiblingProcess } = await import('xxscreeps/engine/db/storage/local/responder.js');
			if (await isSiblingProcess()) {
				throw new Error('Another local storage host is running; stop all services instead of docker exec');
			}
		}
	}
	let report: MapReport | HighwayReport;
	if (argv.initialize) {
		report = await initializeSeason2Map(shard, { serverStopped: argv['server-stopped'] });
	} else if (argv.restore) {
		report = await restoreSeason2Map(shard, { serverStopped: argv['server-stopped'] });
	} else if (argv['seal-highways']) {
		report = argv['dry-run']
			? await previewHighwaySealing(shard)
			: await sealSeason2Highways(shard, { serverStopped: argv['server-stopped'] });
	} else {
		report = await previewSeason2Map(shard);
	}
	console.log(JSON.stringify(report, null, 2));
	if (!write && (report.state === 'conflict' || report.state === 'prepared')) {
		process.exitCode = 1;
	}
}

if (process.argv[1] === 'season2-map') {
	await main();
}
