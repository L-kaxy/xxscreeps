import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { RoomIntentPayload } from 'xxscreeps/engine/processor/room.js';
import type { World } from 'xxscreeps/game/map.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import { loadTerrain } from 'xxscreeps/driver/pathfinder/pathfinder.js';
import { acquireIntentsForRoom } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { RoomPosition, iterateNeighbors } from 'xxscreeps/game/position.js';
import { TerrainWriter } from 'xxscreeps/game/terrain.js';
import { Creep, create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { kInvaderUserId } from 'xxscreeps/mods/classic/invader/game.js';
import { create as createInvader } from 'xxscreeps/mods/classic/invader/processor.js';
import { kSourceKeeperUserId } from 'xxscreeps/mods/classic/source/game.js';
import { StructureKeeperLair } from 'xxscreeps/mods/classic/source/keeper-lair.js';
import { activateNPC } from 'xxscreeps/mods/npc/processor.js';
import { testWorld } from 'xxscreeps/test/import.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializeSeason2Map, mapStateKey } from './map.js';
import { season2MapRooms } from './original-map.js';
import 'xxscreeps:mods/backend';

const fresh = simulate({});
const oldRoom = 'W7N7';
const newRoom = 'E3N7';
// A real highway fixture with usable exits is the outside positive control.
// W12N1 is deliberately enclosed, so it is suitable only for budget preservation.
const outsideRoom = 'W0N0';
const banked = C.INVADERS_ENERGY_GOAL * 3;

function switches(old: boolean, next: boolean) {
	const previousOld = config.speedrun!.invaders;
	const previousNew = config.speedrunSeason2!.invaders;
	config.speedrun!.invaders = old;
	config.speedrunSeason2!.invaders = next;
	return {
		[Symbol.dispose]() {
			for (const [ settings, previous ] of [ [ config.speedrun!, previousOld ], [ config.speedrunSeason2!, previousNew ] ] as const) {
				if (previous === undefined) {
					delete settings.invaders;
				} else {
					settings.invaders = previous;
				}
			}
		},
	};
}

async function inWorld<Type>(task: (shard: Shard, world: World) => Promise<Type>) {
	return fresh(async ({ shard }) => {
		await initializeSeason2Map(shard, { serverStopped: true });
		const world = await shard.loadWorld();
		loadTerrain(world);
		try {
			return await task(shard, world);
		} finally {
			loadTerrain(testWorld);
		}
	});
}

/** Process real hooks, asynchronous vanilla generation and saved room buffers, not a mocked hook. */
async function processRoom(shard: Shard, world: World, name: string, prepare?: (room: Room) => void, intents?: RoomIntentPayload) {
	const room = await shard.loadRoom(name);
	if (prepare) {
		runOneShot(world, room, shard.time, '', () => prepare(room));
		room['#flushObjects'](null);
		await shard.saveRoom(name, shard.time, room);
	}
	const context = new RoomProcessor(shard, world, room, shard.time);
	if (intents) {
		context.saveIntents('100', intents);
	}
	await context.process();
	await context.finalize(false);
	return room;
}

function budget(amount: number, target = 0) {
	return (room: Room) => {
		room['#cumulativeEnergyHarvested'] = amount;
		room['#invaderEnergyTarget'] = target;
	};
}

function raiders(room: Room) {
	return room['#objects'].filter(object => object instanceof Creep && object['#user'] === kInvaderUserId);
}

async function advance(shard: Shard) {
	await shard.data.set('time', ++shard.time);
}

async function ownNeighbor(shard: Shard, world: World, name: string, reserved: boolean) {
	const room = await shard.loadRoom(name);
	runOneShot(world, room, shard.time, '', () => {
		assert.ok(room.controller, 'the selected interior fixture has controller neighbors');
		room['#user'] = room.controller['#user'] = '100';
		if (reserved) {
			room.controller['#reservationEndTime'] = shard.time + 5000;
		} else {
			room['#level'] = 3;
		}
	});
	await shard.saveRoom(name, shard.time, room);
}

describe('season-2 invaders', () => {
	for (const [ old, next ] of [ [ false, false ], [ false, true ], [ true, false ], [ true, true ] ] as const) {
		test(`independent budgets and actual raids: season1=${old}, season2=${next}`, () => inWorld(async (shard, world) => {
			using settings = switches(old, next);
			for (const [ name, enabled ] of [ [ oldRoom, old ], [ newRoom, next ], [ outsideRoom, true ] ] as const) {
				const below = await processRoom(shard, world, name, budget(1000));
				assert.strictEqual(below['#cumulativeEnergyHarvested'], enabled ? 1000 : 0, name);
				assert.strictEqual(raiders(below).length, 0);
				const above = await processRoom(shard, world, name, budget(banked));
				assert.strictEqual(raiders(above).length, enabled ? 3 : 0, `${name} runs the original generator only when enabled`);
				assert.strictEqual(above['#cumulativeEnergyHarvested'], enabled ? banked : 0);
				// Vanilla randomness can yield a zero next-goal increment; retain that behavior.
				assert.strictEqual(above['#invaderEnergyTarget'] >= banked, enabled, 'only an actual raid updates the original goal');
			}
		}));
	}

	test('all 81 season-2 rooms clear budgets, while highways and another sector retain theirs', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		for (const name of season2MapRooms) {
			assert.strictEqual((await processRoom(shard, world, name, budget(1000)))['#cumulativeEnergyHarvested'], 0, name);
		}
		for (const name of [ outsideRoom, 'W10N10', 'W12N1' ]) {
			assert.strictEqual((await processRoom(shard, world, name, budget(1000)))['#cumulativeEnergyHarvested'], 1000, name);
		}
	}));

	test('first-tick banked energy is cleared durably without changing the original raid target', () => inWorld(async (shard, world) => {
		using settings = switches(true, false);
		const target = C.INVADERS_ENERGY_GOAL;
		const room = await processRoom(shard, world, newRoom, budget(banked, target));
		assert.strictEqual(raiders(room).length, 0, 'no final raid from a pre-deployment budget');
		await advance(shard);
		const saved = await shard.loadRoom(newRoom);
		assert.strictEqual(saved['#cumulativeEnergyHarvested'], 0);
		assert.strictEqual(saved['#invaderEnergyTarget'], target);
		assert.strictEqual(raiders(await processRoom(shard, world, newRoom)).length, 0);
	}));

	test('re-enabling does not resurrect discarded energy, but new banked energy can generate raids', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		let playerId = '';
		await processRoom(shard, world, newRoom, room => {
			budget(banked)(room);
			const player = createCreep(new RoomPosition(25, 25, newRoom), [ C.MOVE ], 'observer', '100');
			playerId = player.id;
			room['#insertObject'](player);
		});
		await advance(shard);
		config.speedrunSeason2!.invaders = true;
		assert.strictEqual(raiders(await processRoom(shard, world, newRoom)).length, 0);
		// A real player intent keeps this vanilla generation tick updated and persisted.
		const enabled = await processRoom(shard, world, newRoom, budget(banked), {
			local: {}, object: { [playerId]: { say: [ 'observe raid', false ] } },
		});
		assert.strictEqual(raiders(enabled).length, 3);
		config.speedrunSeason2!.invaders = false;
		await advance(shard);
		const disabled = await processRoom(shard, world, newRoom);
		assert.strictEqual(disabled['#cumulativeEnergyHarvested'], 0);
		assert.strictEqual(raiders(disabled).length, 3, 'switching off retains the raid already present');
	}));

	for (const enabled of [ false, true ]) {
		test(`actual harvest runs after the budget hook; next tick follows invaders=${enabled}`, () => inWorld(async (shard, world) => {
			using settings = switches(false, enabled);
			let sourceId = '';
			let workerId = '';
			const room = await processRoom(shard, world, newRoom, room => {
				budget(0)(room);
				const source = room.find(C.FIND_SOURCES)[0]!;
				source.energy = source.energyCapacity;
				const pos = [ ...iterateNeighbors(source.pos) ].find(pos =>
					!(world.terrain.get(newRoom)!.terrain.get(pos.x, pos.y) & C.TERRAIN_MASK_WALL)
					&& !room['#objects'].some(object => object.pos.isEqualTo(pos)));
				assert.ok(pos);
				const worker = createCreep(pos, [ C.WORK, C.CARRY, C.MOVE ], 'harvester', '100');
				room['#insertObject'](worker);
				sourceId = source.id;
				workerId = worker.id;
			});
			const context = new RoomProcessor(shard, world, room, shard.time);
			context.saveIntents('100', { local: {}, object: { [workerId]: { harvest: [ sourceId ] } } });
			await context.process();
			await context.finalize(false);
			assert.strictEqual(room['#cumulativeEnergyHarvested'], C.HARVEST_POWER, 'harvest is not suppressed');
			await advance(shard);
			const after = await processRoom(shard, world, newRoom);
			assert.strictEqual(after['#cumulativeEnergyHarvested'], enabled ? C.HARVEST_POWER : 0);
			assert.strictEqual(raiders(after).length, 0);
		}));
	}

	test('disabling generation does not delete an existing Invader or stop its NPC combat', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		// Use plain terrain only in this test world, so adjacent combat is not terrain-dependent.
		const traits = world.terrain.get(newRoom)!;
		world.terrain.set(newRoom, { ...traits, terrain: new TerrainWriter() });
		let victimId = '';
		let invaderId = '';
		const room = await processRoom(shard, world, newRoom, room => {
			budget(banked)(room);
			const victim = createCreep(new RoomPosition(25, 25, newRoom), [ C.MOVE, C.MOVE ], 'victim', '100');
			const invader = createInvader(new RoomPosition(26, 25, newRoom), 'melee', 'small', shard.time + 5000);
			victimId = victim.id;
			invaderId = invader.id;
			room['#insertObject'](victim);
			room['#insertObject'](invader);
			activateNPC(room, kInvaderUserId);
		});
		assert.ok(raiders(room).some(creep => creep.id === invaderId));
		const victim = room['#objects'].find(object => object.id === victimId);
		assert.ok(victim instanceof Creep && victim.hits < 200, 'existing Invader still attacks');
		assert.strictEqual(raiders(room).length, 1, 'no additional periodic wave');
	}));

	test('the central nine stay open and Source Keeper lairs still spawn with Invaders disabled', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		let lairs = 0;
		for (let xx = 4; xx <= 6; ++xx) {
			for (let yy = 4; yy <= 6; ++yy) {
				const name = `E${xx}N${yy}`;
				assert.strictEqual(world.map.getRoomStatus(name).status, 'normal');
				const room = await processRoom(shard, world, name, room => {
					budget(banked)(room);
					for (const object of room['#objects']) {
						if (object instanceof StructureKeeperLair) {
							object['#nextSpawnTime'] = shard.time + 1;
							++lairs;
						}
					}
				});
				assert.strictEqual(raiders(room).length, 0, name);
				const keepers = room['#objects'].filter(object => object instanceof Creep && object['#user'] === kSourceKeeperUserId);
				assert.strictEqual(keepers.length, room['#objects'].filter(object => object instanceof StructureKeeperLair).length);
			}
		}
		assert.strictEqual(lairs, 32, 'real original-map lairs, not a fabricated keeper fixture');
	}));

	for (const reserved of [ false, true ]) {
		test(`enabled generation retains vanilla neighbor filtering: reserved=${reserved}`, () => inWorld(async (shard, world) => {
			using settings = switches(false, true);
			const neighbors = Object.values(world.map.describeExits(newRoom)!);
			assert.strictEqual(neighbors.length, 4);
			for (const name of neighbors) {
				await ownNeighbor(shard, world, name, reserved);
			}
			const room = await processRoom(shard, world, newRoom, budget(banked));
			assert.strictEqual(raiders(room).length, 0);
			assert.strictEqual(room['#cumulativeEnergyHarvested'], banked);
			assert.strictEqual(room['#invaderEnergyTarget'], 0, 'no exits means no consumed budget');
		}));
	}

	test('enabled raids only enter through the remaining uncontrolled neighbor', () => inWorld(async (shard, world) => {
		using settings = switches(false, true);
		const exits = Object.entries(world.map.describeExits(newRoom)!);
		const direction = Number(exits[0]![0]);
		for (const [ , name ] of exits.slice(1)) {
			await ownNeighbor(shard, world, name, false);
		}
		const room = await processRoom(shard, world, newRoom, budget(banked));
		const invasion = raiders(room);
		assert.strictEqual(invasion.length, 3);
		for (const creep of invasion) {
			const { x, y } = creep.pos;
			assert.strictEqual(direction === C.TOP || direction === C.BOTTOM ? y : x, direction === C.TOP || direction === C.LEFT ? 0 : 49);
		}
	}));

	test('enabled generation cannot spawn through a room with no exit tiles', () => inWorld(async (shard, world) => {
		using settings = switches(false, true);
		const terrain = new TerrainWriter();
		for (let ii = 0; ii < 50; ++ii) {
			terrain.set(ii, 0, C.TERRAIN_MASK_WALL);
			terrain.set(ii, 49, C.TERRAIN_MASK_WALL);
			terrain.set(0, ii, C.TERRAIN_MASK_WALL);
			terrain.set(49, ii, C.TERRAIN_MASK_WALL);
		}
		world.terrain.set(newRoom, { ...world.terrain.get(newRoom)!, terrain, exits: 0 });
		const room = await processRoom(shard, world, newRoom, budget(banked));
		assert.strictEqual(raiders(room).length, 0);
		assert.strictEqual(room['#cumulativeEnergyHarvested'], banked);
		assert.strictEqual(room['#invaderEnergyTarget'], 0);
	}));

	test('manual create-invader still follows the original API and internal intent with both switches off', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		const routes = [ ...hooks.map('route') ].filter(info => info.path === '/api/game/create-invader' && info.method === 'post');
		assert.strictEqual(routes.length, 1);
		for (const name of [ oldRoom, newRoom ]) {
			await ownNeighbor(shard, world, name, false);
			const route = routes[0]!;
			assert.deepStrictEqual(await route.execute({
				db: shard.db, shard, backend: { world }, state: { userId: '100' },
				request: { body: { room: name, x: 25, y: 25, size: 'small', type: 'melee' } },
			} as unknown as Parameters<typeof route.execute>[0]), { ok: 1 });
			const intents = await acquireIntentsForRoom(shard, name);
			assert.strictEqual(intents.length, 1);
			const room = await processRoom(shard, world, name, budget(banked), intents[0]!.intents);
			assert.strictEqual(raiders(room).length, 1, 'manual request is not a periodic raid');
			assert.ok(room['#npcData'].users.has(kInvaderUserId));
		}
	}));

	test('processing does not rewrite terrain, map journals or independent competition records', () => inWorld(async (shard, world) => {
		using settings = switches(false, false);
		const terrain = await shard.data.req('terrain', { blob: true });
		const journal = await shard.data.get(mapStateKey);
		await shard.db.data.hSet('speedrun/score/20000/100:1', 'controlPoints', '123');
		await shard.db.data.hSet('speedrun-season2/score/20000/100:1', 'controlPoints', '456');
		for (const name of [ oldRoom, newRoom, outsideRoom ]) {
			await processRoom(shard, world, name, budget(1000));
		}
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), terrain);
		assert.strictEqual(await shard.data.get(mapStateKey), journal);
		assert.strictEqual(await shard.db.data.hGet('speedrun/score/20000/100:1', 'controlPoints'), '123');
		assert.strictEqual(await shard.db.data.hGet('speedrun-season2/score/20000/100:1', 'controlPoints'), '456');
		assert.strictEqual(await shard.data.zCard('speedrun-season2/due'), 0);
		assert.strictEqual(await shard.data.zCard('speedrun-season2/racing'), 0);
	}));
});
