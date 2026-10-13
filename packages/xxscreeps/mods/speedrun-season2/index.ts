import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Step 10 also resumes persistent manual respawn cleanup after room processing.
// The map remains an explicit CLI operation.
// No automatic map writes, timed reset hook or page provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'backend', 'config', 'main', 'processor', 'test' ],
	types,
};
