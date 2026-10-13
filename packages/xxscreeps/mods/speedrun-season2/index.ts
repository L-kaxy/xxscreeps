import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// Scoring, automatic/manual cleanup and independent leaderboard routes are connected.
// Map initialization and highway sealing remain explicit CLI operations, never startup hooks.
// Depend on season 1 so its base rules load first, even if only this extension is listed in mods.
export const manifest: Manifest = {
	dependencies: [ 'xxscreeps/mods/speedrun' ],
	provides: [ 'backend', 'config', 'main', 'processor', 'test' ],
	types,
};
