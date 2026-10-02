#!/usr/bin/env node
import { mods } from 'xxscreeps/config/mods.js';

// Get script and remove `xxscreeps.js` from args
process.argv.splice(1, 1);
const specifier = process.argv[1];

// Launch entry command
const commands = {
	'generate-room': './dist/scripts/generate-room.js',
	'generate-sector': './dist/scripts/generate-sector.js',
	backend: './dist/backend/server.js',
	cli: './dist/cli/cli.js',
	eval: './dist/cli/eval.js',
	export: './dist/scripts/export.js',
	import: './dist/scripts/import.js',
	main: './dist/engine/service/main.js',
	manage: './dist/scripts/manage.js',
	processor: './dist/engine/service/processor.js',
	runner: './dist/engine/service/runner.js',
	start: './dist/engine/service/launcher.js',
	test: './dist/test/run.js',
	types: './dist/scripts/types.js',
	'uniform-terrain': './dist/scripts/uniform-terrain.js',
	...mods.some(mod => mod.url.endsWith('/mods/stronghold-challenge/index.js')) && {
		'prepare-stronghold': './dist/mods/stronghold-challenge/prepare.js',
	},
};
const command = specifier.startsWith('file:') ? specifier : commands[specifier ?? 'cli'];
if (command === undefined) {
	console.error(`Invalid command '${specifier}', built in commands are ${Object.keys(commands).join(', ')}`);
	process.exit(1);
} else {
	await import(command);
}
