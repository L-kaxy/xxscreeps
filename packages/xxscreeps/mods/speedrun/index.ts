import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// speedrun — custom ruleset for this shard.
//
// This mod is the single place where "speedrun" server rules live, so that the upstream tree
// stays untouched and the ruleset can be turned on and off per deployment by editing the mods
// list. Enable it by appending its specifier to `mods` in `.screepsrc.yaml`:
//
//    mods:
//      - xxscreeps/mods/classic
//      - xxscreeps/mods/speedrun
//
// `classic` is declared as a dependency so that it always loads first: speedrun's rules are
// expressed as adjustments on top of the vanilla ruleset, not as a replacement for it.
//
// No provider namespaces are exposed yet (`provides: null`, the same shape `classic` uses for its
// aggregator). When the first piece of logic lands, add its namespace here and create the matching
// file next to this one — providers resolve as `<modDir>/<provide>.ts` or `<modDir>/<provide>/index.ts`:
//
//	- 'processor'      → room/shard tick processors, intents
//	- 'game'           → Game object extensions
//	- 'constants'      → game constants
//	- 'config'         → config `defaults` (needs a sibling `config.schema.json`)
//	- 'schema'         → room/object blob fields (⚠ changes the on-disk schema format)
//	- 'test'           → tests picked up by `xxscreeps test`
export const manifest: Manifest = {
	dependencies: [
		'xxscreeps/mods/classic',
	],
	provides: null,
	types,
};
