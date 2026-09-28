import type { RoomObject } from 'xxscreeps/game/object.js';
import { config } from 'xxscreeps/config/index.js';
import { registerIntentProcessor, registerRoomTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { Ruin } from 'xxscreeps/mods/classic/structure/ruin.js';

// The vanilla raid generator (`mods/classic/invader`) sends a party of three small invaders once a
// room's harvest budget passes `INVADERS_ENERGY_GOAL`, and only then banks the goal for the next
// raid. Parking `#cumulativeEnergyHarvested` at zero therefore keeps the generator from ever
// reaching its threshold.
//
// Ordering: room tick processors run in registration order and `classic` is a dependency of this
// mod, so the generator always reads the counter before this runs. What it reads is at most the
// harvest of the previous tick — the harvest intents which increment the counter are applied after
// the room tick processors of the same tick — which is orders of magnitude below the goal.
//
// A room which banked a budget before this mod was loaded may still spawn one last raid on the
// first tick it is processed.
registerRoomTickProcessor((room, context) => {
	if (config.speedrun?.invaders === false && room['#cumulativeEnergyHarvested'] !== 0) {
		room['#cumulativeEnergyHarvested'] = 0;
		context.didUpdate();
	}
});

// The two resource generators -- `mods/modern/deposit` and `mods/modern/powerbank` -- put their
// objects down through the internal room intents `placeDeposit` and `placePowerBank`. A shard tick
// processor picks a room and pushes the intent, and the room intent stage reads terrain and inserts
// the object; that stage is therefore the one point every deposit and every power bank has to pass,
// and the point this rule takes over.
//
// `registerIntentProcessor` appends to a list and `initializeIntentConstraints`
// (`engine/processor/index.ts:137-201`) sorts that list, then hands the room stage the *first* entry
// whose receiver matches the room (`room.ts:134`). Registering the same intent on `Room` while
// naming that intent in `before` therefore shadows the generator's handler: the intent arrives, the
// placement is dropped, and no object is created. Existing objects are not touched -- they keep
// their tick processor, their decay and their schedule, so a generator which is switched back on
// picks up where it left off (its next fire is at most one cadence away). Nothing is written to or
// deleted from the world.
//
// The switch is read while the module loads, so flipping it needs a service restart.
if (config.speedrun?.deposits !== true) {
	registerIntentProcessor(Room, 'placeDeposit', { before: [ 'placeDeposit' ], internal: true }, () => {});
}
if (config.speedrun?.powerBanks !== true) {
	registerIntentProcessor(Room, 'placePowerBank', { before: [ 'placePowerBank' ], internal: true }, () => {});
}

// A destroyed structure leaves a ruin behind. Every lane which puts one down goes through
// `Room['#insertObject']` (`game/room/room.ts:168`), so that one method is the whole surface:
//
//   - `Structure['#destroy']` hands a ruin over for every structure destroyed in combat or by
//     decay (`mods/classic/structure/structure.ts:96-101`; a nuke death skips it),
//   - the two spawn intents do the same for every owned structure of a room which is being handed
//     to a new player or given up, with a `100000`/`500000` tick decay -- those are the ones which
//     outlive the fight by hours (`mods/classic/spawn/processor.ts:77`, `:101`).
//
// Dropping the object at the door instead of deleting a ruin afterwards means one never reaches a
// room blob: the schema keeps its `ruin` variant, the on-disk format does not move, and a rollback
// has no half-written object to pick up. The `EVENT_OBJECT_DESTROYED` entry of the structure which
// died is still appended, and the store it carried goes with the ruin.
//
// The switch is read per insertion so a test can flip it inside a running process; the value in
// `.screepsrc.yaml` is read while a service boots, so an operator flipping that one still needs a
// restart. Tombstones -- the other kind of leftover, left by a dying creep -- are a different door
// (`mods/classic/creep/processor.ts`) and are not touched.
Room.prototype['#insertObject'] = function(insertObject) {
	return function(this: Room, object: RoomObject, now?: boolean) {
		if (config.speedrun?.ruins === true || !(object instanceof Ruin)) {
			insertObject.call(this, object, now);
		}
	};
}(Room.prototype['#insertObject']);
