import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Step 1 is configuration-only. No gameplay, map, storage or backend provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'config', 'test' ],
	types,
};
