import { config } from 'xxscreeps/config/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { TERRAIN_MASK_WALL, TerrainWriter } from 'xxscreeps/game/terrain.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { computeRoomMeta, roomType } from 'xxscreeps/mods/modern/sector/terrain.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializationDefaults } from './config.js';
import { roomsToClose, sectorCoreRooms } from './rooms.js';
import { isSolid, wallSectorCores } from './walls.js';

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

	describe('solid sector cores', () => {
		// The same 2x2 quadrant of sectors, this time with terrain: `TerrainWriter` starts all-plain
		// and `exits` starts wide open, so both the painting and the recomputed bitfield are visible.
		const quadrant = new Set<string>([ ...function*() {
			for (let xx = 0; xx < 21; ++xx) {
				for (let yy = 0; yy < 21; ++yy) {
					yield `W${xx}N${yy}`;
				}
			}
		}() ]);
		const terrain = new Map([ ...quadrant ].map(name => {
			const { sectors, sectorControl } = computeRoomMeta(name, quadrant);
			return [ name, { sectors, sectorControl, exits: 15, terrain: new TerrainWriter() } ] as const;
		}));
		const core = sectorCoreRooms(terrain);
		const touched = wallSectorCores(terrain, core);

		test('the ruleset ships with the cores walled', () => {
			assert.strictEqual(
				initializationDefaults.speedrun.wallSectorCores,
				true,
				'an operator opts out with `wallSectorCores: false`',
			);
		});

		test('every tile of every core room is wall', () => {
			assert.strictEqual(core.length, 36, 'four centers, nine rooms each');
			for (const name of core) {
				const record = terrain.get(name)!;
				assert.strictEqual(record.exits, 0, `${name} advertises no way out`);
				for (const [ xx, yy ] of [ [ 0, 0 ], [ 49, 0 ], [ 0, 49 ], [ 49, 49 ], [ 25, 25 ], [ 24, 26 ] ] as const) {
					assert.strictEqual(record.terrain.get(xx, yy), TERRAIN_MASK_WALL, `${name} ${xx},${yy} is wall`);
				}
			}
		});

		test('the rooms around a core are sealed on the side which faces it', () => {
			// Two neighbours of the core room `W6N5`. `W7N5` is on its west side and `W3N5` on its
			// east one -- `parseSignedRoomName` gives `W6` = -7 and `W7` = -8, so a *larger* W number
			// is further west. Each has the edge facing the core walled, the opposite edge open, and
			// lost exactly the exit which led into the core.
			const westSide = terrain.get('W7N5')!;
			for (let yy = 0; yy < 50; ++yy) {
				assert.strictEqual(westSide.terrain.get(49, yy), TERRAIN_MASK_WALL, `W7N5 49,${yy} is wall`);
			}
			assert.strictEqual(westSide.terrain.get(0, 25), 0, 'the far side of W7N5 is untouched');
			assert.strictEqual(westSide.exits, 1 | 4 | 8, 'W7N5 keeps the three it does not face the core with');

			const eastSide = terrain.get('W3N5')!;
			for (let yy = 0; yy < 50; ++yy) {
				assert.strictEqual(eastSide.terrain.get(0, yy), TERRAIN_MASK_WALL, `W3N5 0,${yy} is wall`);
			}
			assert.strictEqual(eastSide.terrain.get(49, 25), 0, 'the far side of W3N5 is untouched');
			assert.strictEqual(eastSide.exits, 1 | 2 | 4, 'W3N5 keeps the three it does not face the core with');

			// Two rooms out from the same core nothing was written at all.
			for (const name of [ 'W8N5', 'W2N5' ]) {
				assert.strictEqual(terrain.get(name)!.exits, 15, `${name} is not adjacent to a core`);
			}
		});

		test('rooms which do not touch a core are left alone', () => {
			for (const name of [ 'W1N1', 'W7N7', 'W10N10' ]) {
				assert.strictEqual(terrain.get(name)!.exits, 15, `${name} keeps all four exits`);
				assert.ok(!touched.includes(name), `${name} was not written to`);
			}
		});

		test('the sector records survive, so resource placement keeps working', () => {
			const center = terrain.get('W5N5')!;
			assert.ok(center.sectorControl, 'the center room still carries its sector');
			assert.strictEqual(center.sectorControl.edges.length, 40, 'and its highway ring with it');
		});

		test('a solid core is recognised and a plain one is not', () => {
			assert.strictEqual(isSolid(terrain, core), true);
			assert.strictEqual(isSolid(terrain, [ 'W1N1' ]), false);
		});

		test('walling an already solid core changes nothing', () => {
			const snapshot = () => [ ...terrain ]
				.map(([ name, record ]) => `${name}:${record.exits}:${record.terrain.get(25, 25)}`)
				.join(' ');
			const before = snapshot();
			wallSectorCores(terrain, core);
			assert.strictEqual(snapshot(), before, 'a second pass is a no-op');
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
