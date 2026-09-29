import type { ObjectPlan } from 'xxscreeps/mods/speedrun/template.js';
import type { UniformReport } from 'xxscreeps/mods/speedrun/uniform.js';
import * as fs from 'node:fs/promises';
import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { applyUniformTerrain, restoreUniform } from 'xxscreeps/mods/speedrun/uniform.js';
import { parseRoomOptions } from 'xxscreeps/scripts/generate-room.js';

// One world for the whole interior, as a command rather than as a rule a service start applies: it
// runs when an operator runs it and does nothing on its own.
//
// Every room of every sector's 9x9 interior -- everything but the core, 72 rooms of the stock world
// -- is overwritten with one generated template and given the same sources, mineral and controller
// on the same tiles, so no room is a better start than another. The terrain is `generate-room`'s own
// generator, sharing its `--terrain-type` and `--swamp-type` ranges, with one change: every side
// carries the same centred opening (`--exits`, default 8) instead of the exits the neighbours happen
// to have, so two rooms built from it share a border tile for tile and the whole grid walks through.
// A layout which comes out in several pieces is repaired rather than rerolled, so every layout
// connects. The objects follow `room-gen`'s own placement rules off that terrain, so every source,
// mineral and controller ends up on ground with room to work from -- `--sources` sets how many.
//
// Two stores are written, under the game mutex, and both are kept aside first:
//
//   - the terrain blob, under `speedrun/terrainBackup`;
//   - the room blob of every room whose objects changed, under `speedrun/uniformRoomBackup`.
//
// `--restore` puts both back. The template itself can be kept in a file with `--save` and stamped
// again with `--template`, which also keeps its object plan, so the same tiles come back.
//
// A running service holds its own copy of the terrain, so a written terrain is only served from the
// next start; the rooms are read from storage every time a room is processed. Which storage that is
// matters: run from a second container and this process keeps its own copy of the data directory,
// which the running engine writes its in-memory rooms back over every couple of minutes -- so the
// terrain would take and the objects would not. `docker stop xxscreeps` before the run, or run the
// command inside the container (`docker exec -i xxscreeps …`), where it shares the engine's store.
// The command says which side it is on (`storage: sibling` or `storage: files`).

const usage = 'Usage: xxscreeps uniform-terrain [--shard shard] [--terrain-type 1-28] [--swamp-type 0-14]\n' +
	'         [--exits 8] [--sources 1-4] [--mineral H|O|Z|K|U|L|X] [--no-objects]\n' +
	'         [--template file.json] [--save file.json] [--dry-run] [--restore]';

const kDefaultExits = 8;

function parseExitWidth(value: string | undefined) {
	if (value === undefined) {
		return kDefaultExits;
	}
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 2 || parsed > 46 || parsed % 2 !== 0) {
		throw new Error('exits must be an even integer from 2 to 46, so the opening is centred');
	}
	return parsed;
}

/** A template file: the packed terrain, the layout which makes it readable in an editor, and the
 * object plan the terrain was planned with. */
interface TemplateFile {
	terrain: number[];
	layout: string[];
	terrainType: number;
	swampType: number;
	exitWidth: number;
	objects?: ObjectPlan;
}

function layoutOf(terrain: Readonly<Uint8Array>) {
	const characters = [ '.', '#', '~' ];
	return Array.from({ length: 50 }, (_, yy) => Array.from({ length: 50 }, (_, xx) => {
		const index = yy * 50 + xx;
		return characters[(terrain[index >>> 2]! >>> ((index & 0x03) << 1)) & 0x03];
	}).join(''));
}

async function readTemplate(file: string) {
	const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<TemplateFile>;
	if (!Array.isArray(parsed.terrain) || parsed.terrain.length !== 625) {
		throw new Error(`${file} does not hold a template: the terrain entry has to be 625 packed bytes`);
	}
	return { terrain: Uint8Array.from(parsed.terrain), plan: parsed.objects };
}

async function writeTemplate(file: string, report: UniformReport) {
	const contents: TemplateFile = {
		terrain: [ ...report.terrain ],
		layout: layoutOf(report.terrain),
		terrainType: report.terrainType,
		swampType: report.swampType,
		exitWidth: report.exitWidth,
		...report.plan === undefined ? {} : { objects: report.plan },
	};
	await fs.writeFile(file, `${JSON.stringify(contents, null, 1)}\n`);
}

function loseLine(losses: UniformReport['lossesBefore']) {
	const parts = [
		losses.sources === 0 ? '' : `${losses.sources} source(s)`,
		losses.minerals === 0 ? '' : `${losses.minerals} mineral(s)`,
		losses.controllers === 0 ? '' : `${losses.controllers} controller(s)`,
	].filter(part => part !== '');
	return parts.length === 0 ? 'none' : parts.join(', ');
}

function describe(report: UniformReport) {
	const lines = [
		`template: terrain-type ${report.terrainType}, swamp-type ${report.swampType}, ` +
			`${report.exitWidth} tile exits${report.generated ? '' : ' (from a file)'}` +
			`${report.repaired ? `, repaired to connect after ${report.attempts} attempts` : ''}`,
		`covered ${report.covered} rooms` +
			`${report.ringFaces === 0 ? '' : `, opened ${report.ringFaces} highway ring faces`}, ` +
			`${report.written ? 'terrain written' : 'terrain already uniform'}`,
	];
	if (report.sources === undefined) {
		lines.push('objects left where they are (--no-objects)');
	} else {
		const { moved, added, removed, nudged } = report.objects;
		lines.push(
			`objects: ${report.sources} source(s) per room` +
				`${report.mineral === undefined ? '' : `, mineral ${report.mineral}`}, ` +
				`one mineral and one controller; ${report.roomsWritten} room(s) rewritten` +
				`${moved === 0 ? '' : `, ${moved} object(s) moved`}` +
				`${added === 0 ? '' : `, ${added} added`}` +
				`${removed === 0 ? '' : `, ${removed} removed`}`,
		);
	}
	lines.push(`ground beside the objects, before: ${loseLine(report.lossesBefore)}; ` +
		`after: ${loseLine(report.lossesAfter)}`);
	if (report.objects.nudged !== 0) {
		lines.push(`${report.objects.nudged} object(s) took the nearest free ground, their planned ` +
			`tile being taken: ${report.nudgedRooms.join(' ')}`);
	}
	if (report.blockedRooms.length !== 0) {
		lines.push(`${report.blockedRooms.length} room(s) had no ground to give an object: ` +
			`${report.blockedRooms.join(' ')}`);
	}
	if (report.failedRooms.length !== 0) {
		lines.push(`${report.failedRooms.length} room(s) could not be rewritten and were left alone: ` +
			`${report.failedRooms.join(' ')}`);
	}
	lines.push(report.flagged.length === 0
		? 'every source, mineral and controller has ground to work from'
		: `still without ground beside them: ${report.flagged.join(' ')}`);
	return lines.join('\n');
}

/**
 * Which store this process is writing: the one the running engine holds, or its own copy of the data
 * directory.
 *
 * The local provider either connects a process to whatever host already holds the storage -- a
 * sibling, which sees the engine's live data -- or makes it a host of its own over the files. A
 * server which is running keeps its rooms in memory and flushes them back over those files every
 * `saveInterval` (two minutes by default), so a room written on the wrong side of that line is
 * overwritten before anyone is served it: an operator running this from a second container sees the
 * terrain take (the engine reads that blob once, at boot, and never writes it back) and none of the
 * objects. Hence the warning below, and the note in the usage.
 */
async function storageMode() {
	try {
		const { isSiblingProcess } = await import('xxscreeps/engine/db/storage/local/responder.js');
		return await isSiblingProcess() ? 'sibling' : 'files';
	} catch {
		return 'unknown';
	}
}

async function main() {
	const argv = checkArguments({
		argv: true,
		boolean: [ 'dry-run', 'restore', 'no-objects' ] as const,
		string: [ 'shard', 'exits', 'template', 'save', 'terrain-type', 'swamp-type', 'sources', 'mineral' ] as const,
	});
	if (argv.argv.length !== 0) {
		// Unlike `generate-room` there is no room to name: the template goes over the whole interior.
		console.log(usage);
		process.exitCode = 1;
		return;
	}
	const exits = parseExitWidth(argv.exits);
	const options = parseRoomOptions(argv);
	// `parseRoomOptions` types a mineral as a resource or `false` (its "no mineral" flag, which the
	// command line can't ask for); narrow it so an unset one stays out of the request entirely.
	const mineral = options.mineral === false ? undefined : options.mineral;
	const file = argv.template === undefined ? undefined : await readTemplate(argv.template);
	if (file?.plan !== undefined && options.sources !== undefined && options.sources !== file.plan.sources.length) {
		throw new Error(`${argv.template} holds a plan for ${file.plan.sources.length} source(s); ` +
			'drop --sources or match it, or the tiles would not line up');
	}

	await using db = await Database.connect();
	await using shard = await Shard.connect(db, argv.shard ?? config.shards[0]!.name);
	const storage = await storageMode();
	if (storage === 'files') {
		console.log('This process has its own copy of the data directory rather than the running ' +
			'engine\'s store. If a server is up, stop it first: it keeps its rooms in memory and ' +
			'writes them back over the files, so the object half of the stamp would be undone.');
	}
	if (argv.restore) {
		const restored = await restoreUniform(shard);
		await Promise.all([ db.save(), shard.save() ]);
		console.log(restored.terrain
			? `Put the terrain and ${restored.rooms} room(s) back the way they were before the first stamp`
			: 'Nothing to restore: no terrain under `speedrun/terrainBackup`');
		return;
	}

	const report = await applyUniformTerrain(shard, {
		// `exactOptionalPropertyTypes` is on, so an unset flag is left out rather than passed as
		// `undefined` -- the same shape `generate-room` builds its options in.
		...options.terrainType === undefined ? {} : { terrainType: options.terrainType },
		...options.swampType === undefined ? {} : { swampType: options.swampType },
		exitWidth: exits,
		...argv.template === undefined ? {} : { template: file!.terrain },
		...file?.plan === undefined ? {} : { plan: file.plan },
		...options.sources === undefined ? {} : { sources: options.sources },
		...mineral === undefined ? {} : { mineral },
		...argv['no-objects'] ? { objects: false } : {},
	}, { dryRun: argv['dry-run'] });
	await Promise.all([ db.save(), shard.save() ]);
	console.log(`${describe(report)}\nstorage: ${storage}`);
	if (argv.save !== undefined) {
		await writeTemplate(argv.save, report);
		console.log(`Template written to ${argv.save}`);
	}
	if (report.written || report.roomsWritten !== 0) {
		console.log('Restart the server to serve the new terrain; the rooms are read on their next ' +
			'tick, and `--restore` puts both back.');
		if (report.generated) {
			console.log('Another run rolls a new terrain of the same layout; `--save` and `--template` keep one exactly.');
		}
	}
}

if (process.argv[1] === 'uniform-terrain') {
	await main();
}
