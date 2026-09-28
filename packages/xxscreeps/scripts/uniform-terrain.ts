import type { UniformReport } from 'xxscreeps/mods/speedrun/uniform.js';
import * as fs from 'node:fs/promises';
import { checkArguments } from 'xxscreeps/config/arguments.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { applyUniformTerrain, restoreTerrain } from 'xxscreeps/mods/speedrun/uniform.js';
import { parseRoomOptions } from 'xxscreeps/scripts/generate-room.js';

// One terrain for the whole interior, as a command rather than as a rule a service start applies: it
// runs when an operator runs it and does nothing on its own.
//
// Every room of every sector's 9x9 interior -- everything but the core, 72 rooms of the stock world
// -- is overwritten with one generated template, so no room is a better start than another. The
// template is `generate-room`'s own generator, sharing its `--terrain-type` and `--swamp-type`
// ranges, with one change: every side carries the same centred opening (`--exits`, default 8)
// instead of the exits the neighbours happen to have, so two rooms built from it share a border tile
// for tile and the whole grid walks through. A layout which comes out in several pieces is repaired
// rather than rerolled, so every layout connects.
//
// Terrain is the only thing written: no room blob is rewritten and no object is read, moved or
// deleted. The sources a wall landed next to are printed at the end instead, for the operator to
// decide about. The terrain from before the first stamp is kept under `speedrun/terrainBackup`, which
// `--restore` writes back; the template itself can be kept in a file with `--save` and stamped again
// with `--template`.
//
// A running service holds its own copy of the world, so the written terrain is only served from the
// next start; and the write itself is safest with the server stopped (`docker stop xxscreeps`),
// which is also what `manage game pause` is for on a running one.

const usage = 'Usage: xxscreeps uniform-terrain [--shard shard] [--terrain-type 1-28] [--swamp-type 0-14]\n' +
	'         [--exits 8] [--template file.json] [--save file.json] [--dry-run] [--restore]';

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

/** A template file: the packed terrain, plus the layout which makes it readable in an editor. */
interface TemplateFile {
	terrain: number[];
	layout: string[];
	terrainType: number;
	swampType: number;
	exitWidth: number;
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
	return Uint8Array.from(parsed.terrain);
}

async function writeTemplate(file: string, report: UniformReport) {
	const contents: TemplateFile = {
		terrain: [ ...report.terrain ],
		layout: layoutOf(report.terrain),
		terrainType: report.terrainType,
		swampType: report.swampType,
		exitWidth: report.exitWidth,
	};
	await fs.writeFile(file, `${JSON.stringify(contents, null, 1)}\n`);
}

function describe(report: UniformReport) {
	const lines = [
		`template: terrain-type ${report.terrainType}, swamp-type ${report.swampType}, ` +
			`${report.exitWidth} tile exits${report.generated ? '' : ' (from a file)'}` +
			`${report.repaired ? `, repaired to connect after ${report.attempts} attempts` : ''}`,
		`covered ${report.covered} rooms` +
			`${report.ringFaces === 0 ? '' : `, opened ${report.ringFaces} highway ring faces`}` +
			`${report.written ? ', terrain written' : ', nothing written'}`,
	];
	if (report.flagged.length === 0) {
		lines.push('every object keeps open ground beside it');
	} else {
		lines.push(`${report.lostSources} source(s) and ${report.lostOthers} other object(s) have no ` +
			`open ground beside them: ${report.flagged.join(' ')}`);
	}
	return lines.join('\n');
}

async function main() {
	const argv = checkArguments({
		argv: true,
		boolean: [ 'dry-run', 'restore' ] as const,
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
	if (options.sources !== undefined || options.mineral !== undefined) {
		throw new Error('--sources and --mineral do not apply here: rooms keep their own objects, ' +
			'so this command only writes terrain');
	}

	await using db = await Database.connect();
	await using shard = await Shard.connect(db, argv.shard ?? config.shards[0]!.name);
	if (argv.restore) {
		const restored = await restoreTerrain(shard);
		await Promise.all([ db.save(), shard.save() ]);
		console.log(restored
			? 'Put the terrain back the way it was before the first stamp'
			: 'Nothing to restore: no terrain under `speedrun/terrainBackup`');
		return;
	}

	const report = await applyUniformTerrain(shard, {
		// `exactOptionalPropertyTypes` is on, so an unset flag is left out rather than passed as
		// `undefined` -- the same shape `generate-room` builds its options in.
		...options.terrainType === undefined ? {} : { terrainType: options.terrainType },
		...options.swampType === undefined ? {} : { swampType: options.swampType },
		exitWidth: exits,
		...argv.template === undefined ? {} : { template: await readTemplate(argv.template) },
	}, { dryRun: argv['dry-run'] });
	await Promise.all([ db.save(), shard.save() ]);
	console.log(describe(report));
	if (argv.save !== undefined) {
		await writeTemplate(argv.save, report);
		console.log(`Template written to ${argv.save}`);
	}
	if (report.written) {
		console.log('Restart the server to serve the new terrain; `--restore` puts the old one back.');
		if (report.generated) {
			console.log('Another run rolls a new terrain of the same layout; `--save` and `--template` keep one exactly.');
		}
	}
}

if (process.argv[1] === 'uniform-terrain') {
	await main();
}
