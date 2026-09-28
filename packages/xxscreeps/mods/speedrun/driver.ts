import { config } from 'xxscreeps/config/index.js';
import { hooks } from 'xxscreeps/engine/runner/index.js';

// The ruleset's switches live in `config`, but the runner sandbox cannot read it: every mod's
// `game` provider is evaluated inside the sandbox's own module graph, where `xxscreeps/config`
// resolves to the virtual `xxscreeps:mods/config` module that the sandbox loader refuses
// (`driver/sandbox/nodejs/index.ts:73-80`). Whatever a rule has to know in there therefore travels
// the way `mods/meta/flag` sends flag blobs: stamped onto the payload on the runner side by this
// hook, read back inside the sandbox by the matching `runtimeConnector` in `game.ts`.
declare module 'xxscreeps/engine/runner/index.js' {
	interface TickPayload {
		/** Whether `Creep.claimController` may record an intent this tick. */
		speedrunClaimControllerAllowed: boolean;
	}
}

hooks.register('runnerConnector', async () => [ () => {}, {
	refresh(payload) {
		payload.speedrunClaimControllerAllowed = config.speedrun?.claimController !== false;
	},
} ]);
