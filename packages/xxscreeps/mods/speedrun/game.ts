import type { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import { hooks } from 'xxscreeps/game/index.js';
import * as C from 'xxscreeps:mods/constants';

// `Creep.claimController` is installed by `mods/classic/controller` with
// `extend(Creep, { claimController })`, which defines a plain writable property on
// `Creep.prototype` (`utility/utility.ts:63-73`). Every mod's `game` provider is concatenated into
// the virtual `xxscreeps:mods/game` module, and that module is what the runner sandbox evaluates
// (`driver/sandbox/nodejs/index.ts:76`), so the wrapper written here is the one a player's
// `Game.creeps.*` objects call.
//
// The refusal happens before `intents.save` runs, so no `claimController` intent is ever recorded
// and no downstream code needs guarding: a room cannot change hands. The code returned is
// `ERR_INVALID_TARGET`, the one the vanilla check already uses for "this controller is not
// claimable by you" (`mods/classic/controller/creep.ts:176-184`), so a bot branching on error codes
// takes a path it already handles.
//
// Only this API is wrapped: `reserveController`, `attackController` and `upgradeController` are
// untouched, and the starting room the backend hands a new player goes through its own `placeSpawn`
// intent, which never calls this method.
//
// The switch arrives on the tick payload from `driver.ts` -- `xxscreeps/config` is not reachable
// from inside a sandbox module -- and it fails closed: a payload without the field, or an undefined
// value, leaves claiming off. `sandboxRules` is exported so tests can drive the same value.
export const sandboxRules = {
	claimController: false,
};

hooks.register('runtimeConnector', {
	receive(payload) {
		sandboxRules.claimController = payload.speedrunClaimControllerAllowed === true;
	},
});

const vanillaClaimController = Creep.prototype.claimController;

Creep.prototype.claimController = function(target: StructureController) {
	if (!sandboxRules.claimController) {
		return C.ERR_INVALID_TARGET;
	}
	return vanillaClaimController.call(this, target);
};
