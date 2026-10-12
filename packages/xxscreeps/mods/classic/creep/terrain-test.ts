import { World } from 'xxscreeps/game/map.js';
import { search } from 'xxscreeps/game/pathfinder/index.js';
import { makePositionChecker } from 'xxscreeps/game/pathfinder/obstacle.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { TerrainWriter, getBuffer, packExits } from 'xxscreeps/game/terrain.js';
import { create as createSite } from 'xxscreeps/mods/classic/construction/construction-site.js';
import { create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { checkBorder, checkWall } from 'xxscreeps/mods/classic/structure/structure.js';
import { exportPayload, importPayload } from 'xxscreeps/scripts/payload.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { create } from './creep.js';

// The test world is shared. Change its existing packed buffer so native pathfinding sees the
// same terrain as Game, and always restore it, including when an assertion fails.
async function withTerrain(world: World, roomName: string, body: (terrain: TerrainWriter) => Promise<void>) {
	const buffer = getBuffer(world.terrain.get(roomName)!.terrain);
	const original = buffer.slice();
	try {
		await body(new TerrainWriter(buffer as Uint8Array<ArrayBuffer>));
	} finally {
		buffer.set(original);
	}
}

const combined = C.TERRAIN_MASK_WALL | C.TERRAIN_MASK_SWAMP;
const simulation = simulate({
	W0N0: room => {
		room['#insertObject'](create(new RoomPosition(25, 25, room.name), [ C.MOVE, C.CARRY ], 'walker', '100'));
	},
});

describe('terrain bitmasks', () => {
	test('get normalizes combined terrain to WALL while raw access preserves its bits', () => simulation(async ({ world, peekRoom }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			for (let mask = 0; mask < 4; ++mask) {
				terrain.set(20 + mask, 20, mask);
			}
			await peekRoom('W0N0', (room, Game) => {
				const strings = [ 'plain', 'wall', 'swamp', 'wall' ];
				for (let mask = 0; mask < 4; ++mask) {
					assert.strictEqual(room.getTerrain().get(20 + mask, 20), mask === combined ? C.TERRAIN_MASK_WALL : mask);
					assert.strictEqual(room.getTerrain().getRawBuffer()[20 * 50 + 20 + mask], mask);
					assert.deepStrictEqual(room.lookForAt(C.LOOK_TERRAIN, 20 + mask, 20), [ strings[mask] ]);
					assert.strictEqual(Game.map.getTerrainAt(20 + mask, 20, room.name), strings[mask]);
				}
			});
		});
	}));

	for (const mask of [ 0, C.TERRAIN_MASK_WALL, C.TERRAIN_MASK_SWAMP, combined ]) {
		test(`movement respects wall bit for mask ${mask}`, () => simulation(async ({ world, player, tick, peekRoom }) => {
			await withTerrain(world, 'W0N0', async terrain => {
				terrain.set(26, 25, mask);
				await player('100', Game => {
					assert.strictEqual(Game.creeps.walker!.move(C.RIGHT), C.OK);
				});
				await tick();
				await peekRoom('W0N0', room => {
					const creep = room.find(C.FIND_CREEPS).find(creep => creep.name === 'walker')!;
					assert.strictEqual(creep.pos.x, mask & C.TERRAIN_MASK_WALL ? 25 : 26);
					assert.strictEqual(creep.pos.y, 25);
				});
			});
		}));

		test(`position and construction checks respect wall bit for mask ${mask}`, () => simulation(async ({ world, peekRoom }) => {
			await withTerrain(world, 'W0N0', async terrain => {
				terrain.set(26, 25, mask);
				await peekRoom('W0N0', room => {
					const pos = new RoomPosition(26, 25, room.name);
					const check = makePositionChecker({ room, user: '100', checkTerrain: true });
					assert.strictEqual(check(pos), (mask & C.TERRAIN_MASK_WALL) === 0);
					assert.strictEqual(checkWall(pos), mask & C.TERRAIN_MASK_WALL ? C.ERR_INVALID_TARGET : C.OK);
				});
			});
		}));
	}

	test('packed exits and FIND_EXIT exclude combined wall tiles on every side', () => simulation(async ({ world, peekRoom }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			for (let ii = 0; ii < 50; ++ii) {
				terrain.set(ii, 0, combined);
				terrain.set(49, ii, combined);
				terrain.set(ii, 49, combined);
				terrain.set(0, ii, combined);
			}
			assert.strictEqual(packExits(terrain), 0);
			await peekRoom('W0N0', room => {
				assert.deepStrictEqual(room.find(C.FIND_EXIT), []);
				assert.strictEqual(checkBorder(new RoomPosition(25, 1, room.name)), C.OK);
			});
			terrain.set(25, 0, C.TERRAIN_MASK_SWAMP);
			assert.strictEqual(packExits(terrain), 1);
			await peekRoom('W0N0', room => {
				assert.deepStrictEqual(room.find(C.FIND_EXIT_TOP).map(pos => [ pos.x, pos.y ]), [ [ 25, 0 ] ]);
				assert.strictEqual(checkBorder(new RoomPosition(25, 1, room.name)), C.ERR_INVALID_TARGET);
			});
		});
	}));

	test('native and room pathfinding reject combined walls without roads', () => simulation(async ({ world, peekRoom }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			terrain.set(26, 25, combined);
			await peekRoom('W0N0', room => {
				const from = new RoomPosition(25, 25, room.name);
				const to = new RoomPosition(27, 25, room.name);
				const paths = [
					search(from, to, { maxRooms: 1 }).path,
					room.findPath(from, to, { maxRooms: 1 }),
				];
				for (const path of paths) {
					assert.ok(path.length > 0);
					assert.ok(!path.some(pos => pos.x === 26 && pos.y === 25));
				}
			});
		});
	}));

	test('completed roads on combined walls remain walkable with wall cost and hits', () => simulation(async ({ world, poke, player, tick, peekRoom }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			terrain.set(26, 25, combined);
			await poke('W0N0', undefined, (_Game, room) => {
				const road = createRoad(new RoomPosition(26, 25, room.name));
				assert.strictEqual(road.hitsMax, C.ROAD_HITS * C.CONSTRUCTION_COST_ROAD_WALL_RATIO);
				// Roads persisted before the fix can still carry the unnormalized mask.
				road['#terrain'] = combined;
				assert.strictEqual(road.hitsMax, C.ROAD_HITS * C.CONSTRUCTION_COST_ROAD_WALL_RATIO);
				room['#insertObject'](road);
			});
			await player('100', Game => {
				const creep = Game.creeps.walker!;
				const path = creep.room.findPath(creep.pos, new RoomPosition(26, 25, creep.pos.roomName), { maxRooms: 1 });
				assert.ok(path.some(pos => pos.x === 26 && pos.y === 25));
				assert.strictEqual(creep.move(C.RIGHT), C.OK);
			});
			await tick();
			await peekRoom('W0N0', room => {
				assert.strictEqual(room.find(C.FIND_CREEPS)[0]!.pos.x, 26);
			});
		});
	}));

	test('road construction uses wall multiplier rather than plain or swamp multiplier', () => simulation(async ({ world, poke, player, tick, peekRoom }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			terrain.set(26, 25, combined);
			await player('100', Game => {
				assert.strictEqual(Game.rooms.W0N0!.createConstructionSite(26, 25, C.STRUCTURE_ROAD), C.OK);
			});
			await tick();
			await peekRoom('W0N0', room => {
				const site = room.find(C.FIND_CONSTRUCTION_SITES)[0]!;
				assert.strictEqual(site.progressTotal, C.CONSTRUCTION_COST.road * C.CONSTRUCTION_COST_ROAD_WALL_RATIO);
			});
			// A road under construction must not punch a tunnel yet.
			await poke('W0N0', undefined, (_Game, room) => {
				for (const site of room.find(C.FIND_CONSTRUCTION_SITES)) {
					room['#removeObject'](site);
				}
				room['#insertObject'](createSite(new RoomPosition(26, 25, room.name), C.STRUCTURE_ROAD, '100', 100));
			});
			await player('100', Game => {
				Game.creeps.walker!.move(C.RIGHT);
			});
			await tick();
			await peekRoom('W0N0', room => {
				assert.strictEqual(room.find(C.FIND_CREEPS)[0]!.pos.x, 25);
			});
		});
	}));

	test('payload terrain round-trip treats combined terrain as wall', () => simulation(async ({ world, shard }) => {
		await withTerrain(world, 'W0N0', async terrain => {
			terrain.set(26, 25, combined);
			const worldBuffer = world.terrain;
			// loadWorld reads the persisted world, whereas the simulation uses its shared test world.
			const loadWorld = shard.loadWorld.bind(shard);
			try {
				shard.loadWorld = () => Promise.resolve(world);
				const { payload } = await exportPayload(shard);
				const imported = importPayload(payload);
				const restored = new World(world.name, imported.terrain);
				assert.strictEqual(restored.terrain.get('W0N0')!.terrain.get(26, 25), C.TERRAIN_MASK_WALL);
			} finally {
				shard.loadWorld = loadWorld;
			}
			assert.strictEqual(world.terrain, worldBuffer);
		});
	}));
});
