import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Step 8 starts independent clocks after successful handover, alongside block-local Invaders.
// The map remains an explicit CLI operation.
// No automatic map writes, scoring/reset tick hook, cleanup or page provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'backend', 'config', 'processor', 'test' ],
	types,
};
