import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Step 9 records independent bracket results after room processing.
// The map remains an explicit CLI operation.
// No automatic map writes, reset hook, cleanup or page provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'backend', 'config', 'main', 'processor', 'test' ],
	types,
};
