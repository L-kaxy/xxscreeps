import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import type { RoomObject } from 'xxscreeps/game/object.js';
import { config } from 'xxscreeps/config/index.js';
import { intentProcessors, roomTickProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Game, me } from 'xxscreeps/game/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { Ruin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { startRun, stopRun } from './race.js';
import { isSpeedrunRoom } from './scope.js';
// The respawn rule chains the engine's `unspawn` handler instead of adding a registration of its
// own, so it lives in a module of its own. See `respawn.ts`.
import './respawn.js';

// The vanilla raid generator (`mods/classic/invader`) sends a party of three small invaders once a
// room's harvest budget passes `INVADERS_ENERGY_GOAL`, and only then banks the goal for the next
// raid. Parking `#cumulativeEnergyHarvested` at zero therefore keeps the generator from ever
// reaching its threshold.
//
// Clear only season 1, before the vanilla generator, so even an old banked budget cannot create
// one last raid. Harvest intents run later; the next tick clears their budget before generation.
roomTickProcessors.unshift((room, context) => {
	if (isSpeedrunRoom(room.name) && config.speedrun?.invaders === false && room['#cumulativeEnergyHarvested'] !== 0) {
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
// These two switches intentionally remain global, including highways and other seasons. Chain
// each vanilla handler so enabling its switch restores placement. Existing resources keep ticking.
for (const [ intent, setting ] of [ [ 'placeDeposit', 'deposits' ], [ 'placePowerBank', 'powerBanks' ] ] as const) {
	const placement = intentProcessors.find(info => info.intent === intent && info.receiver === Room);
	if (placement) {
		const vanilla = placement.process;
		placement.process = (room: Room, context: ProcessorContext, ...data: unknown[]) => {
			if (config.speedrun?.[setting] === true) {
				vanilla(room, context, ...data);
			}
		};
	}
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
// `speedrun.ruins` is global, including both seasons, highways and other sectors.
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

// The race starts when a room is handed to a player: `placeSpawn` is the intent both a first landing
// and a respawn go through, so it is chained rather than shadowed -- the same shape `respawn.ts` uses
// for `unspawn`, and for the same reason: the room stage only calls the first registration whose
// receiver matches, so a second `placeSpawn` would replace the handover instead of following it.
//
// The write is queued as a task because an intent handler cannot await; the room processor flushes
// its tasks before the room is saved. `Game.time` is the tick the landing happened on, which is what
// the brackets in `race.ts` are counted from.
const placeSpawn = intentProcessors.find(info => info.intent === 'placeSpawn' && info.receiver === Room);
if (placeSpawn) {
	const handover = placeSpawn.process;
	placeSpawn.process = (room: Room, context: ProcessorContext, ...data: unknown[]) => {
		const wasUnowned = room['#user'] === null;
		handover(room, context, ...data);
		if (!wasUnowned || room['#user'] !== me) {
			return;
		}
		if (isSpeedrunRoom(room.name)) {
			// Even with brackets disabled, a successful landing ends the other season's clock.
			context.task(startRun(context.shard, me, room.name, Game.time));
		} else {
			// A landing elsewhere supersedes the old clock, but never starts an old-season race.
			context.task(stopRun(context.shard, me, Game.time));
		}
	};
}
