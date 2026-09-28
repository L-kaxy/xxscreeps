import { config } from 'xxscreeps/config/index.js';
import { registerRoomTickProcessor } from 'xxscreeps/engine/processor/index.js';

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
