import { config } from 'xxscreeps/config/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { computeRoomMeta, roomType } from 'xxscreeps/mods/modern/sector/terrain.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializationDefaults } from './config.js';
import { roomsToClose } from './rooms.js';

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

	describe('sector-core closure', () => {
		test('the ruleset ships with the cores closed', () => {
			assert.strictEqual(
				initializationDefaults.speedrun.closeCenterNine,
				true,
				'an operator opts out with `closeCenterNine: false`',
			);
		});

		// A 2x2 block of sectors: `W10N10` rings all four centers, exactly the fixture
		// `mods/modern/sector` asserts its own room meta against.
		const quadrant = new Set<string>([ ...function*() {
			for (let xx = 0; xx < 21; ++xx) {
				for (let yy = 0; yy < 21; ++yy) {
					yield `W${xx}N${yy}`;
				}
			}
		}() ]);
		// Stamped the way `xxscreeps import` stamps a world: one record per room, `sectorControl` only
		// on the centers.
		const terrain = new Map([ ...quadrant ].map(name => [ name, computeRoomMeta(name, quadrant) ] as const));
		const open = [ ...quadrant ];
		const closing = roomsToClose(terrain, open);

		test('the sector records name the four centers of the quadrant', () => {
			const centers = [ ...terrain ]
				.filter(([ , record ]) => record.sectorControl !== undefined)
				.map(([ name ]) => name);
			assert.strictEqual(centers.sort().join(' '), 'W15N15 W15N5 W5N15 W5N5');
		});

		test('every center contributes its own 3x3, and nothing else', () => {
			assert.strictEqual(closing.length, 36, 'four centers, nine rooms each, no overlap between them');
			for (const name of [ 'W5N5', 'W4N4', 'W6N6', 'W14N14', 'W16N16', 'W4N14', 'W16N4', 'W14N16' ]) {
				assert.ok(closing.includes(name), `${name} belongs to a sector core`);
			}
			for (const name of [ 'W7N7', 'W3N5', 'W10N10', 'W13N13', 'W17N15' ]) {
				assert.ok(!closing.includes(name), `${name} does not belong to a sector core`);
			}
		});

		test('the world data and the engine classifier agree on every room of the quadrant', () => {
			const set = new Set(closing);
			for (const name of open) {
				const type = roomType(name);
				assert.strictEqual(
					set.has(name),
					type === 'center' || type === 'sourceKeeper',
					`${name} is ${type}`,
				);
			}
		});

		test('only rooms that were handed in are ever closed', () => {
			assert.deepStrictEqual(
				roomsToClose(terrain, [ 'W1N1', 'W5N4', 'W0N0' ]).join(' '),
				'W5N4',
				'a non-core room, a highway room and an out-of-world neighbour',
			);
		});

		test('a world with no sector records falls back to the classifier', () => {
			const bare: Map<string, { sectorControl?: undefined }> = new Map();
			assert.strictEqual(
				roomsToClose(bare, [ 'W1N1', 'W5N5', 'W7N7', 'W0N0', 'W15N15' ]).join(' '),
				'W5N5 W15N15',
			);
		});
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
