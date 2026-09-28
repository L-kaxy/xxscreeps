import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { GameConstructor } from 'xxscreeps/game/index.js';
import { config } from 'xxscreeps/config/index.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { runShardInitializers } from 'xxscreeps/engine/processor/shard.js';
import { intentProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { instanceOfPredicate } from 'xxscreeps/functional/predicate.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { TERRAIN_MASK_WALL, TerrainWriter } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { Creep, create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureWall, create as createWall } from 'xxscreeps/mods/classic/defense/wall.js';
import { StructureContainer, create as createContainer } from 'xxscreeps/mods/classic/resource/container.js';
import { StructureRoad, create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Ruin, createRuin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { loadSectorDeposits, setDepositBootstrapScatterForTesting } from 'xxscreeps/mods/modern/deposit/main.js';
import { dueSectorsAt } from 'xxscreeps/mods/modern/deposit/model.js';
import { inspectDuePowerBankRoomsForTest, scheduleRoom } from 'xxscreeps/mods/modern/powerbank/model.js';
import { StructurePowerBank } from 'xxscreeps/mods/modern/powerbank/powerbank.js';
import { computeRoomMeta, roomType } from 'xxscreeps/mods/modern/sector/terrain.js';
import { deterministicRandomForTesting } from 'xxscreeps/test/fixtures.js';
import { testWorld } from 'xxscreeps/test/import.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializationDefaults } from './config.js';
import { sandboxRules } from './game.js';
import {
	bestKey, dueRunsKey, playerBracketsKey, playerRunsKey, racingKey, rankKey, readLeaderboard,
	readPlayerBrackets, readPlayerRecords, readRacing, runKey, scoreKey, startRun,
} from './race.js';
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

	describe('resource generators', () => {
		test('the ruleset ships with both generators stopped', () => {
			assert.strictEqual(
				initializationDefaults.speedrun.deposits,
				false,
				'an operator opts in with `deposits: true`',
			);
			assert.strictEqual(
				initializationDefaults.speedrun.powerBanks,
				false,
				'an operator opts in with `powerBanks: true`',
			);
		});

		test('the placement intents resolve to the ruleset handler', () => {
			// The mechanism is that `initializeIntentConstraints` sorts registrations and the room
			// intent stage takes the first entry whose receiver matches the room. The generator's
			// handler carries the four arguments of the intent, the ruleset's carries none.
			for (const intent of [ 'placeDeposit', 'placePowerBank' ]) {
				const infos = intentProcessors.filter(info => info.intent === intent && info.receiver === Room);
				assert.ok(infos.length > 0, `${intent} is registered`);
				assert.strictEqual(infos[0]!.process.length, 0, `${intent} resolves to the ruleset handler`);
			}
		});

		test('a due sector is evaluated without placing a deposit', () => simulate({})(async ({ shard, tick }) => {
			using bootstrap = withDepositBootstrap();
			await runShardInitializers(shard);
			assert.ok((await dueSectorsAt(shard, Date.now())).includes('W5N5'), 'the sector came due');
			await tick(2);
			// The evaluator still ran: it drained the due entry and pushed the next check five minutes
			// out, which is the same pass which pushes the placement intent.
			assert.deepStrictEqual(await dueSectorsAt(shard, Date.now()), [], 'the sector was evaluated');
			const { sectorControl } = testWorld.map['#getRoomTraits']('W5N5');
			assert.ok(sectorControl, 'the test world has a single sector, W5N5');
			const deposits = await loadSectorDeposits(shard, testWorld, 'W5N5', sectorControl.edges);
			assert.strictEqual(deposits.length, 0, 'and no deposit was placed');
		}));

		test('a due highway room runs its timer without placing a power bank', () => simulate({})(async ({ shard, tick }) => {
			using rng = deterministicRandomForTesting();
			const scheduledAt = shard.time;
			await scheduleRoom(shard, 'W0N0', 0);
			await tick(2);
			const room = await shard.loadRoom('W0N0');
			assert.strictEqual(
				Fn.find(room['#objects'], instanceOfPredicate(StructurePowerBank)),
				undefined,
				'no power bank was placed',
			);
			// The generator ran: it rolled the next respawn and pushed the scratch schedule forward.
			const due = (await inspectDuePowerBankRoomsForTest(shard)).find(([ , roomName ]) => roomName === 'W0N0');
			assert.ok(due, 'W0N0 is still scheduled');
			assert.ok(due[0] - scheduledAt >= C.POWER_BANK_RESPAWN_TIME * 0.75, 'its timer moved into the future');
			// The next-due tick is persisted by the intent handler, which the ruleset takes over -- so the
			// room itself is left exactly as it was: nothing is written to the world.
			assert.strictEqual(room['#nextPowerBankTime'], 0, 'the room was not written to');
		}));
	});

	describe('claim rejection', () => {
		test('the ruleset ships with claiming disabled', () => {
			assert.strictEqual(
				initializationDefaults.speedrun.claimController,
				false,
				'an operator opts in with `claimController: true`',
			);
		});

		// `W3N3` carries a neutral controller at (33,32) and a creep next to it with a CLAIM part is
		// the fixture `mods/classic/controller` claims with; GCL 1 with no controlled rooms satisfies
		// the GCL check, so vanilla decides the claim on the controller itself.
		const claimable = simulate({
			W3N3: room => {
				room['#insertObject'](createCreep(new RoomPosition(34, 32, 'W3N3'), [ C.CLAIM, C.MOVE ], 'claimer', '100'));
			},
		});

		function withGclLevelOne(Game: GameConstructor) {
			Game.gcl = { level: 1, progress: 0, progressTotal: C.GCL_MULTIPLY, '#roomCount': 0 };
		}

		test('claimController is refused while the ruleset has it off', () => claimable(async ({ player }) => {
			using claim = withClaimControllerAllowed(false);
			await player('100', Game => {
				withGclLevelOne(Game);
				assert.strictEqual(
					Game.creeps.claimer?.claimController(Game.rooms.W3N3!.controller!),
					C.ERR_INVALID_TARGET,
					'the ruleset refuses the claim before an intent is recorded',
				);
			});
		}));

		test('vanilla claiming decides again when the switch is on', () => claimable(async ({ player }) => {
			using claim = withClaimControllerAllowed(true);
			await player('100', Game => {
				withGclLevelOne(Game);
				assert.strictEqual(
					Game.creeps.claimer?.claimController(Game.rooms.W3N3!.controller!),
					C.OK,
					'the vanilla check is the one which answers',
				);
			});
		}));
	});
});

describe('ruin suppression', () => {
	// `Room['#insertObject']` is the one door a ruin goes through: `Structure['#destroy']` hands one
	// over for every structure killed in combat or lost to decay, and the two spawn intents do the
	// same for every owned structure of a room which is being handed to a new player or given up.
	// The fixture knocks on that door with the object `createRuin` builds for a spawn -- which is
	// what those lanes hand it -- and the room carries a creep so the object is there to be found.
	const ruined = simulate({
		W7N7: room => {
			room['#insertObject'](createCreep(dummyPos, [ C.MOVE ], 'dummy', '100'));
			room['#insertObject'](createRuin(createSpawn(new RoomPosition(27, 25, 'W7N7'), '100', 'RuinedSpawn')));
		},
	});

	test('the ruleset ships without ruins', () => {
		assert.strictEqual(
			initializationDefaults.speedrun.ruins,
			false,
			'an operator opts in with `ruins: true`',
		);
	});

	test('ruins off: the ruin handed to the room never lands', () => ruined(async ({ player, tick }) => {
		using suppression = withRuins(false);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await player('100', Game => {
			assert.strictEqual(Game.rooms.W7N7?.find(C.FIND_RUINS).length, 0, 'no ruin was inserted');
		});
	}));

	test('ruins on: the same room keeps it', () => ruined(async ({ player, tick }) => {
		using suppression = withRuins(true);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await player('100', Game => {
			const ruins = Game.rooms.W7N7?.find(C.FIND_RUINS);
			assert.strictEqual(ruins?.length, 1, 'the vanilla ruin is back');
			assert.strictEqual(ruins?.[0]?.structureType, C.STRUCTURE_SPAWN, 'and it is the ruined spawn');
		});
	}));
});

describe('respawn cleanup', () => {
	// The respawn route reads the *presence* room set and queues one `unspawn` intent per room
	// (`mods/classic/spawn/backend.ts:192-199`); these tests queue the same intent straight into the
	// engine. Every fixture leaves a road, a container and a wall standing, none of them owned.
	const leftoversIn = (room: Room) => room['#objects'].filter(object =>
		object instanceof StructureRoad ||
		object instanceof StructureContainer ||
		object instanceof StructureWall).length;

	test('the ruleset ships with the respawn cleanup on', () => {
		assert.strictEqual(
			initializationDefaults.speedrun.respawnCleanup,
			true,
			'an operator opts out with `respawnCleanup: false`',
		);
	});

	// A room the leaving player controls, next to the road of a neighbour which must not be touched.
	const held = simulate({
		W7N7: room => {
			room['#level'] = 4;
			room['#user'] = room.controller!['#user'] = '100';
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W7N7'), [ C.MOVE ], 'dummy', '100'));
			room['#insertObject'](createRoad(new RoomPosition(21, 25, 'W7N7')));
			room['#insertObject'](createContainer(new RoomPosition(22, 25, 'W7N7')));
			room['#insertObject'](createWall(new RoomPosition(23, 25, 'W7N7')));
		},
		W8N7: room => {
			room['#insertObject'](createRoad(new RoomPosition(21, 25, 'W8N7')));
		},
	});

	test('a room the leaving player held is cleared of its leftovers', () => held(async ({ shard, player, tick, peekRoom }) => {
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await respawn(shard, 'W7N7', '100');
		await tick();
		const room = await peekRoom('W7N7', room => ({
			leftovers: leftoversIn(room),
			controller: room['#objects'].some(object => object instanceof StructureController),
			ruins: room['#objects'].filter(object => object instanceof Ruin).length,
		}));
		assert.deepStrictEqual(room, { leftovers: 0, controller: true, ruins: 0 });
		assert.strictEqual(
			await peekRoom('W8N7', leftoversIn),
			1,
			'the room next door is not the respawn of this player',
		);
	}));

	// The same leftovers, this time in a room the player never owned: they only had a creep in it.
	const visited = simulate({
		W7N7: room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W7N7'), [ C.MOVE ], 'dummy', '100'));
			room['#insertObject'](createRoad(new RoomPosition(21, 25, 'W7N7')));
			room['#insertObject'](createContainer(new RoomPosition(22, 25, 'W7N7')));
			room['#insertObject'](createWall(new RoomPosition(23, 25, 'W7N7')));
		},
	});

	test('a room where only a creep was left is cleared while nobody else is in it', () => visited(async ({ shard, player, tick, peekRoom }) => {
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await respawn(shard, 'W7N7', '100');
		await tick();
		assert.strictEqual(await peekRoom('W7N7', leftoversIn), 0, 'the leftovers come out');
	}));

	test('the cleanup is skipped while it is switched off', () => visited(async ({ shard, player, tick, peekRoom }) => {
		using cleanup = withRespawnCleanup(false);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await respawn(shard, 'W7N7', '100');
		await tick();
		assert.strictEqual(await peekRoom('W7N7', leftoversIn), 3, 'the leftovers stay standing');
	}));

	// The same room again, this time with a creep of another player standing in it.
	const contested = simulate({
		W7N7: room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W7N7'), [ C.MOVE ], 'dummy', '100'));
			room['#insertObject'](createCreep(new RoomPosition(26, 25, 'W7N7'), [ C.MOVE ], 'intruder', '101'));
			room['#insertObject'](createRoad(new RoomPosition(21, 25, 'W7N7')));
		},
	});

	test('a room another player is standing in is left alone', () => contested(async ({ shard, player, tick, peekRoom }) => {
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await respawn(shard, 'W7N7', '100');
		await tick();
		const room = await peekRoom('W7N7', room => ({
			roads: room['#objects'].filter(object => object instanceof StructureRoad).length,
			creeps: room['#objects'].filter(object => object instanceof Creep).length,
		}));
		assert.deepStrictEqual(room, { roads: 1, creeps: 1 }, 'the room was left as it was');
	}));

	// A room the leaving player was never in, even though the intent names it.
	const elsewhere = simulate({
		W7N7: room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W7N7'), [ C.MOVE ], 'dummy', '100'));
		},
		W8N7: room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W8N7'), [ C.MOVE ], 'resident', '101'));
			room['#insertObject'](createRoad(new RoomPosition(21, 25, 'W8N7')));
		},
	});

	test('a room the leaving player was never in keeps its leftovers', () => elsewhere(async ({ shard, player, tick, peekRoom }) => {
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await respawn(shard, 'W8N7', '100');
		await tick();
		assert.strictEqual(await peekRoom('W8N7', leftoversIn), 1, 'a room they were never in is not theirs to clear');
	}));
});

/** Queue the room intent the respawn route queues, without going through the HTTP route. */
async function respawn(shard: Shard, roomName: string, userId: string) {
	await pushIntentsForRoomNextTick(shard, roomName, userId, { local: { unspawn: [ [] ] }, internal: true });
}

/** Toggle the respawn cleanup for one test, restoring whatever the configuration said. */
function withRespawnCleanup(respawnCleanup: boolean) {
	const settings = config.speedrun ??= {};
	const previous = settings.respawnCleanup;
	settings.respawnCleanup = respawnCleanup;
	return {
		[Symbol.dispose]() {
			if (previous === undefined) {
				delete settings.respawnCleanup;
			} else {
				settings.respawnCleanup = previous;
			}
		},
	};
}

describe('race results', () => {
	// `W3N3` carries the neutral controller the claim fixtures use, so a landing has one to claim.
	// `racing` starts that room already held at RCL 3 with 1000 progress -- 200 + 45000 + 1000 control
	// points -- and far enough from a downgrade that a handful of ticks cannot move it.
	const landed = simulate({
		W3N3: room => {
			room['#insertObject'](createCreep(new RoomPosition(34, 32, 'W3N3'), [ C.MOVE ], 'dummy', '100'));
		},
	});
	const racing = simulate({
		W3N3: room => {
			room['#level'] = 3;
			room['#user'] = room.controller!['#user'] = '100';
			room.controller!['#progress'] = 1000;
			room.controller!['#downgradeTime'] = 100000;
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W3N3'), [ C.MOVE ], 'dummy', '100'));
		},
	});
	const foreignRoom = simulate({
		W3N3: room => {
			room['#level'] = 3;
			room['#user'] = room.controller!['#user'] = '101';
			room.controller!['#progress'] = 1000;
			room.controller!['#downgradeTime'] = 100000;
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W3N3'), [ C.MOVE ], 'resident', '101'));
		},
	});

	test('the ruleset ships with the two brackets', () => {
		assert.deepStrictEqual(
			initializationDefaults.speedrun.raceBrackets,
			[ 20000, 40000 ],
			'an operator changes the offsets, or passes an empty list to record nothing',
		);
	});

	test('a landing starts a run and schedules every bracket', () => landed(async ({ shard, player, tick }) => {
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await land(shard, 'W3N3', '100');
		await tick();
		const run = await shard.db.data.hGetAll(runKey('100'));
		assert.strictEqual(run.room, 'W3N3');
		assert.strictEqual(run.run, '1');
		const startedTick = Number(run.startedTick);
		assert.deepStrictEqual(
			await shard.data.zRangeWithScores(dueRunsKey, -Infinity, Infinity, { by: 'SCORE' }),
			[ [ startedTick + 20000, '100:1:20000' ], [ startedTick + 40000, '100:1:40000' ] ],
		);
	}));

	test('a bracket is recorded when it comes due', () => racing(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2, 4 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await startRun(shard, '100', 'W3N3', shard.time);
		await tick(3);
		const score = await shard.db.data.hGetAll(scoreKey(2, '100:1'));
		assert.strictEqual(score.bracket, '2');
		assert.strictEqual(score.controlPoints, '46200');
		assert.strictEqual(score.level, '3');
		assert.strictEqual(score.progress, '1000');
		assert.strictEqual(score.progressTotal, '135000');
		assert.strictEqual(score.room, 'W3N3');
		assert.strictEqual(score.run, '1');
		assert.strictEqual(score.runId, '100:1');
		assert.strictEqual(score.user, '100');
		assert.ok(Number(score.at) > 0, 'the entry carries the timestamp it landed at');
		assert.strictEqual(await shard.db.data.zScore(rankKey(2), '100:1'), 46200);
		assert.strictEqual(await shard.db.data.zCard(rankKey(4)), 0, 'the later bracket is not due yet');
		assert.deepStrictEqual(
			await shard.data.zRange(dueRunsKey, -Infinity, Infinity, { by: 'SCORE' }),
			[ '100:1:4' ],
		);
	}));

	test('a room below RCL 2 does not enter', () => landed(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await land(shard, 'W3N3', '100');
		await tick(3);
		assert.deepStrictEqual(await shard.db.data.hGetAll(scoreKey(2, '100:1')), {});
		assert.strictEqual(await shard.db.data.zCard(rankKey(2)), 0);
	}));

	test('a room which is no longer theirs does not enter', () => foreignRoom(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await startRun(shard, '100', 'W3N3', shard.time);
		await tick(2);
		assert.deepStrictEqual(await shard.db.data.hGetAll(scoreKey(2, '100:1')), {});
		assert.strictEqual(await shard.db.data.zCard(rankKey(2)), 0);
	}));

	test('a superseded run stops scoring, the newer one still scores', () => racing(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 4 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await startRun(shard, '100', 'W3N3', shard.time);
		await tick();
		await startRun(shard, '100', 'W3N3', shard.time);
		await tick(5);
		assert.deepStrictEqual(await shard.db.data.zRange(rankKey(4), 0, 10), [ '100:2' ]);
		assert.deepStrictEqual(
			await shard.db.data.hGetAll(scoreKey(4, '100:1')),
			{},
			'the superseded run recorded nothing',
		);
		// A third landing keeps what the second one recorded.
		await startRun(shard, '100', 'W3N3', shard.time);
		await tick(5);
		assert.deepStrictEqual(await shard.db.data.zRange(rankKey(4), 0, 10), [ '100:2', '100:3' ]);
	}));

	test('an empty bracket list records nothing', () => landed(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await land(shard, 'W3N3', '100');
		await tick();
		assert.deepStrictEqual(await shard.db.data.hGetAll(runKey('100')), {}, 'no run was started');
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 0);
	}));
});

// The three pages a race board is built from: a bracket's list, one player's records, and the runs
// still in progress. Two rooms held at different levels give the list something to order -- `W3N3` at
// RCL 3 with 1000 progress (46200 control points) and `W4N3` at RCL 4 (180200) -- and one below the
// entry bar, since a run which has not reached RCL 2 is still a run.
describe('race pages', () => {
	const twoRacers = simulate({
		W3N3: room => {
			room['#level'] = 3;
			room['#user'] = room.controller!['#user'] = '100';
			room.controller!['#progress'] = 1000;
			room.controller!['#downgradeTime'] = 100000;
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W3N3'), [ C.MOVE ], 'dummy', '100'));
		},
		W4N3: room => {
			room['#level'] = 4;
			room['#user'] = room.controller!['#user'] = '101';
			room.controller!['#downgradeTime'] = 100000;
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W4N3'), [ C.MOVE ], 'dummy', '101'));
		},
	});
	const belowBar = simulate({
		W3N3: room => {
			room['#level'] = 1;
			room['#user'] = room.controller!['#user'] = '100';
			room.controller!['#progress'] = 50;
			room.controller!['#downgradeTime'] = 100000;
			room['#insertObject'](createCreep(new RoomPosition(25, 25, 'W3N3'), [ C.MOVE ], 'dummy', '100'));
		},
	});

	/** Land one player in a room at the current tick. */
	async function landIn(shard: Shard, userId: string, roomName: string) {
		await startRun(shard, userId, roomName, shard.time);
	}

	test('the list holds one row per player, their best first', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await player('101', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await landIn(shard, '100', 'W3N3');
		await landIn(shard, '101', 'W4N3');
		await tick(3);
		const page = await readLeaderboard(shard, 2, 0, 10);
		assert.strictEqual(page.count, 2, 'both players are on the board');
		assert.deepStrictEqual(
			page.list.map(entry => [ entry.rank, entry.user, entry.score ]),
			[ [ 0, '101', 180200 ], [ 1, '100', 46200 ] ],
			'ordered by control points, ranked from zero',
		);
		assert.strictEqual(page.list[0]?.record?.level, 4);
		assert.strictEqual(page.list[0]?.record?.room, 'W4N3');
		assert.strictEqual(page.list[0]?.record?.run, 1);
		assert.ok((page.list[0]?.record?.at ?? 0) > 0, 'the row carries when it was recorded');
		assert.strictEqual(page.list[0]?.record?.elapsed, 2, 'and how long the run had been going');
		assert.deepStrictEqual(
			await readPlayerBrackets(shard, '100'),
			[ { bracket: 2, score: 46200 } ],
			'the brackets a player holds come back with their best',
		);
		assert.strictEqual(await shard.db.data.zCard(bestKey(2)), 2, 'and the board is one entry per player');
	}));

	test('a worse run adds a record without replacing the best', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await landIn(shard, '100', 'W4N3');
		await tick(3);
		await landIn(shard, '100', 'W3N3');
		await tick(3);
		assert.deepStrictEqual(
			await shard.db.data.zRangeWithScores(bestKey(2), 0, 10, { by: 'SCORE' }),
			[ [ 180200, '100' ] ],
			'the board still holds the better run',
		);
		assert.deepStrictEqual(await shard.db.data.hGetAll(playerBracketsKey('100')), { '2': '180200' });
		assert.strictEqual(await shard.db.data.zCard(playerRunsKey(2, '100')), 2, 'both runs are on file');
		const page = await readLeaderboard(shard, 2, 0, 10);
		assert.deepStrictEqual(
			page.list.map(entry => [ entry.user, entry.score, entry.record?.room ]),
			[ [ '100', 180200, 'W4N3' ] ],
		);
	}));

	test('the records of a player come back best first, with their standing', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await landIn(shard, '100', 'W3N3');
		await tick(3);
		await landIn(shard, '100', 'W4N3');
		await tick(3);
		const records = await readPlayerRecords(shard, '100', [ 2 ]);
		assert.deepStrictEqual(
			records.map(entry => [ entry.record.room, entry.score, entry.rank, entry.record.run ]),
			[ [ 'W4N3', 180200, 0, 2 ], [ 'W3N3', 46200, 1, 1 ] ],
			'every run, best first, each with the place it took',
		);
		assert.deepStrictEqual(
			await readPlayerRecords(shard, '100', []),
			[],
			'and nothing is read for a bracket which was not asked for',
		);
	}));

	test('the live board reads the rooms of the runs in progress', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 20000, 40000 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		const started = shard.time;
		await landIn(shard, '100', 'W3N3');
		const list = await readRacing(shard, shard.time);
		assert.deepStrictEqual(
			list.map(entry => [
				entry.user, entry.room, entry.run, entry.level, entry.progress, entry.score,
				entry.startedTick, entry.elapsed,
			]),
			[ [ '100', 'W3N3', 1, 3, 1000, 46200, started, 0 ] ],
			'the level is the one in the room right now',
		);
		assert.deepStrictEqual(list[0]?.brackets, [
			{ bracket: 20000, dueTick: started + 20000, left: 20000 },
			{ bracket: 40000, dueTick: started + 40000, left: 40000 },
		]);
	}));

	test('a run below RCL 2 stays on the live board, with nothing recorded', () => belowBar(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2, 4 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await landIn(shard, '100', 'W3N3');
		await tick(3);
		assert.deepStrictEqual(await shard.db.data.hGetAll(scoreKey(2, '100:1')), {}, 'nothing was recorded');
		assert.strictEqual(await shard.db.data.zCard(rankKey(2)), 0);
		assert.strictEqual(await shard.data.zCard(racingKey), 1, 'and the run is still on');
		assert.deepStrictEqual(
			(await readRacing(shard, shard.time)).map(entry => [ entry.user, entry.level, entry.score ]),
			[ [ '100', 1, 50 ] ],
		);
	}));

	test('a room which is no longer theirs drops off the live board', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		// `W4N3` is 101's room, so the run is on the board but the room is not the player's.
		await landIn(shard, '100', 'W4N3');
		assert.strictEqual(await shard.data.zCard(racingKey), 1, 'the landing put the run on the board');
		assert.deepStrictEqual(await readRacing(shard, shard.time), [], 'but the room is not theirs');
		assert.strictEqual(await shard.data.zCard(racingKey), 0, 'so the entry is dropped as it is read');
	}));

	test('the last bracket takes the run off the live board', () => twoRacers(async ({ shard, player, tick }) => {
		using brackets = withRaceBrackets([ 2, 4 ]);
		await player('100', Game => {
			Game.creeps.dummy?.move(C.TOP);
		});
		await tick();
		await landIn(shard, '100', 'W3N3');
		await tick(3);
		assert.strictEqual(await shard.data.zCard(racingKey), 1, 'still racing until the last bracket');
		await tick(2);
		assert.strictEqual(await shard.data.zCard(racingKey), 0, 'and off the board once both are in');
		assert.deepStrictEqual(
			await readPlayerBrackets(shard, '100'),
			[ { bracket: 2, score: 46200 }, { bracket: 4, score: 46200 } ],
		);
		assert.deepStrictEqual(await shard.db.data.zRangeWithScores(bestKey(4), 0, 10, { by: 'SCORE' }), [ [ 46200, '100' ] ]);
	}));
});

/** Queue the `placeSpawn` intent a landing goes through (`mods/classic/spawn/backend.ts:172`). */
async function land(shard: Shard, roomName: string, userId: string) {
	await pushIntentsForRoomNextTick(shard, roomName, userId, {
		local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] },
		internal: true,
	});
}

/** Set the recorded brackets for one test, restoring whatever the configuration said. */
function withRaceBrackets(raceBrackets: number[]) {
	const settings = config.speedrun ??= {};
	const previous = settings.raceBrackets;
	settings.raceBrackets = raceBrackets;
	return {
		[Symbol.dispose]() {
			if (previous === undefined) {
				delete settings.raceBrackets;
			} else {
				settings.raceBrackets = previous;
			}
		},
	};
}

/** Deterministic placement RNG plus a zero-scatter bootstrap, so the test world's sector comes due at init. */
function withDepositBootstrap(seed = 1): Disposable {
	const stack = new DisposableStack();
	stack.use(deterministicRandomForTesting(seed));
	stack.use(setDepositBootstrapScatterForTesting(() => 0));
	return stack;
}

/** Drive the sandbox switch `driver.ts` stamps onto the tick payload, restoring whatever it was. */
function withClaimControllerAllowed(claimController: boolean) {
	const previous = sandboxRules.claimController;
	sandboxRules.claimController = claimController;
	return {
		[Symbol.dispose]() {
			sandboxRules.claimController = previous;
		},
	};
}

/** Toggle ruin suppression for one test, restoring whatever the configuration said. */
function withRuins(ruins: boolean) {
	const settings = config.speedrun ??= {};
	const previous = settings.ruins;
	settings.ruins = ruins;
	return {
		[Symbol.dispose]() {
			if (previous === undefined) {
				delete settings.ruins;
			} else {
				settings.ruins = previous;
			}
		},
	};
}

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
