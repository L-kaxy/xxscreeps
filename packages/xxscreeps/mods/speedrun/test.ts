import { config } from 'xxscreeps/config/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';

// `W7N7` has exits in all four directions and all of them lead to uncontrolled rooms — the same
// fixture `mods/classic/invader` runs its exit filtering against.
const dummyPos = new RoomPosition(25, 25, 'W7N7');

/** A harvesting room whose budget has not reached the raid threshold yet. */
const budgeted = simulate({
	W7N7: room => {
		// Player creep activates the room for processing
		room['#insertObject'](createCreep(dummyPos, [ C.MOVE ], 'dummy', '100'));
		room['#cumulativeEnergyHarvested'] = 1000;
	},
});

/** The same room, with a budget well past the raid threshold. */
const banked = simulate({
	W7N7: room => {
		// Player creep activates the room for processing
		room['#insertObject'](createCreep(dummyPos, [ C.MOVE ], 'dummy', '100'));
		room['#cumulativeEnergyHarvested'] = C.INVADERS_ENERGY_GOAL * 3;
	},
});

describe('mods/speedrun', () => {
	describe('raid suppression', () => {
		test('invaders off: the harvest budget is cleared every tick', () => budgeted(async ({ player, tick, peekRoom }) => {
			using raidGeneration = withInvaders(false);
			await player('100', Game => {
				Game.creeps.dummy?.move(C.TOP);
			});
			await tick();
			const harvested = await peekRoom('W7N7', room => room['#cumulativeEnergyHarvested']);
			assert.strictEqual(harvested, 0, 'the raid budget should be cleared while invaders are off');
		}));

		test('invaders on: the harvest budget is left alone', () => budgeted(async ({ player, tick, peekRoom }) => {
			using raidGeneration = withInvaders(true);
			await player('100', Game => {
				Game.creeps.dummy?.move(C.TOP);
			});
			await tick();
			const harvested = await peekRoom('W7N7', room => room['#cumulativeEnergyHarvested']);
			assert.strictEqual(harvested, 1000, 'the raid budget should be untouched while invaders are on');
		}));

		test('invaders on: a banked budget still spawns a raid', () => banked(async ({ player, tick }) => {
			using raidGeneration = withInvaders(true);
			await player('100', Game => {
				Game.creeps.dummy?.move(C.TOP);
			});
			await tick();
			await player('100', Game => {
				const raiders = Game.rooms.W7N7!.find(C.FIND_HOSTILE_CREEPS);
				assert.ok(raiders.length > 0, 'a banked budget should still spawn invaders');
			});
		}));
	});
});

/** Toggle raid generation for one test, restoring whatever the configuration said. */
function withInvaders(invaders: boolean) {
	const settings = config.speedrun ??= {};
	const previous = settings.invaders;
	settings.invaders = invaders;
	return {
		[Symbol.dispose]() {
			if (previous === undefined) {
				delete settings.invaders;
			} else {
				settings.invaders = previous;
			}
		},
	};
}
