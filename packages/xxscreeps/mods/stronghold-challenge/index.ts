import type { Manifest } from 'xxscreeps/config/mods.js';
import rawConfig from 'xxscreeps/config/raw.js';
import * as types from 'xxscreeps/tsroot.js';

if (rawConfig.mods?.includes('xxscreeps/mods/speedrun')) {
	throw new Error('Enable either speedrun or stronghold-challenge on a shard');
}

export const manifest: Manifest = {
	dependencies: [
		'xxscreeps/mods/classic',
		'xxscreeps/mods/mmo/powercreep',
		'xxscreeps/mods/modern/sector',
		'xxscreeps/mods/modern/stronghold',
	],
	provides: [ 'backend', 'game', 'main', 'processor', 'schema', 'test' ],
	types,
};
