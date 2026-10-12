import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Runtime is still configuration-only. Step 3 adds an explicit CLI map initializer, not a provider.
// No gameplay, automatic map writes, storage or backend provider is registered yet.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'config', 'test' ],
	types,
};
