import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Step 4 only restricts initial spawn in this block. The map remains an explicit CLI operation.
// No automatic map writes, season-2 race, cleanup, storage or page provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'backend', 'config', 'processor', 'test' ],
	types,
};
