import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { runShardInitializers } from 'xxscreeps/engine/processor/shard.js';
import { World, schema as worldSchema } from 'xxscreeps/game/map.js';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { TERRAIN_MASK_WALL, TerrainWriter, getBuffer } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureRoad, create as createRoad } from 'xxscreeps/mods/classic/road/road.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import { StructureSpawn, create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Ruin, createRuin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { StructurePowerBank } from 'xxscreeps/mods/modern/powerbank/powerbank.js';
import { computeRoomMeta } from 'xxscreeps/mods/modern/sector/terrain.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { sandboxRules } from './game.js';
import {
	bestKey, captureBracket, dueRunsKey, playerBracketsKey, playerRunsKey, racingKey, rankKey,
	readLeaderboard, readPlayerBrackets, readPlayerRecords, readRacing, resetExpiredRuns, runKey, scoreKey, startRun,
} from './race.js';
import { roomsToClose, sectorCoreRooms } from './rooms.js';
import { isSpeedrunRoom } from './scope.js';
import { applyUniformTerrain, backupKey, restoreUniform } from './uniform.js';
import { wallSectorCores } from './walls.js';

describe('season-1 scope', () => {
	// W12N1 is an existing all-plain fixture outside the old sector. Supply a controller to make
	// its global claiming rule, vanilla landing and respawn paths comparable to the old room.
	const outside = simulate({
		W12N1: room => {
			const controller = createRoomObject(new StructureController(), new RoomPosition(33, 32, room.name));
			controller['#user'] = null;
			room['#user'] = null;
			room['#level'] = 0;
			room['#insertObject'](controller);
			room['#insertObject'](createCreep(new RoomPosition(34, 32, room.name), [ C.CLAIM, C.MOVE ], 'visitor', '100'));
			room['#insertObject'](createRoad(new RoomPosition(25, 24, room.name)));
			room['#cumulativeEnergyHarvested'] = 1000;
		},
	});

	test('exactly the 81 old rooms are in scope', () => {
		for (let xx = 1; xx <= 9; ++xx) {
			for (let yy = 1; yy <= 9; ++yy) {
				assert.strictEqual(isSpeedrunRoom(`W${xx}N${yy}`), true);
			}
		}
		for (const name of [ undefined, '', 'E3N3', 'E5N5', 'W0N3', 'W3N0', 'W10N3', 'W3N10', 'W12N1', 'W03N3', 'W3S3', 'W3N3extra', 'W3N3\n' ]) {
			assert.strictEqual(isSpeedrunRoom(name), false, `${name} is outside season 1`);
		}
	});

	test('closure and walling leave the eastern and other western sectors alone', () => {
		const names = new Set<string>();
		for (const direction of [ 'W', 'E' ]) {
			for (let xx = 0; xx <= 20; ++xx) {
				for (let yy = 0; yy <= 20; ++yy) {
					names.add(`${direction}${xx}N${yy}`);
				}
			}
		}
		const terrain = new Map([ ...names ].map(name => [
			name, { ...computeRoomMeta(name, names), exits: 15, terrain: new TerrainWriter() },
		] as const));
		const core = sectorCoreRooms(terrain);
		assert.strictEqual(core.length, 9);
		assert.deepStrictEqual(roomsToClose(terrain, names).sort(), core.slice().sort());
		const touched = wallSectorCores(terrain, [ ...core, 'E5N5', 'W15N15' ]);
		assert.ok(touched.every(isSpeedrunRoom));
		for (const [ name, record ] of terrain) {
			if (!isSpeedrunRoom(name)) {
				assert.strictEqual(record.exits, 15, `${name} keeps its exits`);
				assert.ok(getBuffer(record.terrain).every(byte => byte === 0), `${name} keeps its terrain`);
			}
		}
	});

	test('disabled invaders do not clear an outside room budget', () => outside(async ({ shard, tick, peekRoom }) => {
		assert.strictEqual(config.speedrun?.invaders, false);
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#cumulativeEnergyHarvested']), 1000);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('100'))), []);
	}));

	test('disabled invaders suppress an already banked old-sector budget', () => simulate({
		W7N7: room => {
			room['#insertObject'](createCreep(new RoomPosition(25, 25, room.name), [ C.MOVE ], 'dummy', '100'));
			room['#cumulativeEnergyHarvested'] = C.INVADERS_ENERGY_GOAL * 3;
		},
	})(async ({ tick, peekRoom }) => {
		await tick();
		assert.strictEqual(await peekRoom('W7N7', room => room.find(C.FIND_HOSTILE_CREEPS).filter(creep => creep['#user'] === '2').length), 0);
	}));

	for (const ruins of [ false, true ]) {
		test(`outside ruins follow the global switch: ${ruins}`, () => outside(async ({ poke, peekRoom }) => {
			const settings = config.speedrun!;
			const previous = settings.ruins;
			settings.ruins = ruins;
			try {
				await poke('W12N1', '100', (_Game, room) => {
					room['#insertObject'](createRuin(createSpawn(new RoomPosition(27, 25, room.name), '100', 'Ruined')));
				});
				assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].filter(object => object instanceof Ruin).length), Number(ruins));
			} finally {
				if (previous === undefined) {
					delete settings.ruins;
				} else {
					settings.ruins = previous;
				}
			}
		}));
	}

	for (const [ deposits, powerBanks ] of [ [ false, false ], [ true, false ], [ false, true ], [ true, true ] ] as const) {
		test(`global resource switches stay independent: deposits=${deposits}, powerBanks=${powerBanks}`, () => simulate({})(async ({ shard, tick, peekRoom }) => {
			const settings = config.speedrun!;
			const previous = { deposits: settings.deposits, powerBanks: settings.powerBanks };
			settings.deposits = deposits;
			settings.powerBanks = powerBanks;
			try {
				for (const name of [ 'W3N3', 'W0N0' ]) {
					await pushIntentsForRoomNextTick(shard, name, '100', {
						local: { placeDeposit: [ [ C.RESOURCE_MIST, 'W5N5' ] ], placePowerBank: [ [ 1000, 50000 ] ] },
						internal: true,
					});
				}
				await tick(2);
				for (const name of [ 'W3N3', 'W0N0' ]) {
					assert.strictEqual(await peekRoom(name, room => room.find(C.FIND_DEPOSITS).length > 0), deposits, `${name} follows the global deposit switch`);
					assert.strictEqual(await peekRoom(name, room => room['#objects'].some(object => object instanceof StructurePowerBank)), powerBanks, `${name} follows the global power bank switch`);
				}
			} finally {
				for (const key of [ 'deposits', 'powerBanks' ] as const) {
					if (previous[key] === undefined) {
						delete settings[key];
					} else {
						settings[key] = previous[key];
					}
				}
			}
		}));
	}

	for (const claimController of [ false, true ]) {
		test(`outside claimController follows the global switch: ${claimController}`, () => outside(async ({ player, tick, peekRoom }) => {
			const settings = config.speedrun!;
			const previous = settings.claimController;
			const previousSandboxRule = sandboxRules.claimController;
			settings.claimController = claimController;
			sandboxRules.claimController = claimController;
			try {
				await player('100', Game => {
					Game.gcl = { level: 1, progress: 0, progressTotal: C.GCL_MULTIPLY, '#roomCount': 0 };
					assert.strictEqual(Game.creeps.visitor!.claimController(Game.rooms.W12N1!.controller!), claimController ? C.OK : C.ERR_INVALID_TARGET);
				});
				await tick();
				assert.strictEqual(await peekRoom('W12N1', room => room['#user']), claimController ? '100' : null);
			} finally {
				sandboxRules.claimController = previousSandboxRule;
				if (previous === undefined) {
					delete settings.claimController;
				} else {
					settings.claimController = previous;
				}
			}
		}));
	}

	for (const name of [ 'W3N3', 'W12N1' ]) {
		test(`real sandbox refreshes the global claim switch in ${name}`, () => simulate({
			[name]: room => {
				if (!room.controller) {
					room['#insertObject'](createRoomObject(new StructureController(), new RoomPosition(33, 32, name)));
					room['#flushObjects'](null);
				}
				room['#user'] = room.controller!['#user'] = null;
				room['#level'] = 0;
				room['#insertObject'](createCreep(new RoomPosition(34, 32, name), [ C.CLAIM, C.MOVE ], 'claimer', '104'));
			},
		})(async ({ sandbox, tick, peekRoom }) => {
			const settings = config.speedrun!;
			const previous = settings.claimController;
			settings.claimController = false;
			try {
				await using instance = await sandbox('104', ({ Game, Memory }) => {
					const creep = Game.creeps.claimer!;
					Game.gcl = { level: 1, progress: 0, progressTotal: 1000000, '#roomCount': 0 };
					const result = creep.claimController(creep.room.controller!);
					assert.strictEqual(result, Memory.allowed ? 0 : -7);
					Memory.allowed = true;
				});
				await tick();
				assert.strictEqual(await peekRoom(name, room => room['#user']), null);
				settings.claimController = true;
				await tick();
				assert.strictEqual(await peekRoom(name, room => room['#user']), '104');
			} finally {
				if (previous === undefined) {
					delete settings.claimController;
				} else {
					settings.claimController = previous;
				}
			}
		}));
	}

	test('global respawn removes outside player objects without season-1 neutral cleanup', () => outside(async ({ shard, tick, peekRoom }) => {
		await respawnPlayer(shard, '100');
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].filter(object => object instanceof StructureRoad).length), 1);
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].some(object => object['#user'] === '100')), false);
	}));

	test('startRun rejects outside rooms without changing the old run', () => simulate({})(async ({ shard }) => {
		await startRun(shard, '100', 'W3N3', shard.time);
		const before = await shard.db.data.hGetAll(runKey('100'));
		for (const name of [ 'E3N3', 'W12N1', 'W0N0' ]) {
			assert.strictEqual(await startRun(shard, '100', name, shard.time), undefined);
		}
		assert.deepStrictEqual(await shard.db.data.hGetAll(runKey('100')), before);
		assert.strictEqual(await shard.data.zCard(racingKey), 1);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 2);
	}));

	test('a successful outside landing cancels the old clock without starting another old run', () => outside(async ({ shard, tick, peekRoom }) => {
		await startRun(shard, '100', 'W3N3', shard.time);
		await pushIntentsForRoomNextTick(shard, 'W12N1', '100', {
			local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] }, internal: true,
		});
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].filter(object => object instanceof StructureSpawn).length), 1);
		const info = await shard.db.data.hGetAll(runKey('100'));
		assert.strictEqual(info.run, '1');
		assert.strictEqual(info.room, 'W3N3');
		assert.ok(info.endedTick !== undefined);
		assert.strictEqual(await shard.data.zCard(racingKey), 0);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 0);
		await resetExpiredRuns(shard, 50000);
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].filter(object => object instanceof StructureSpawn).length), 1);
	}));

	test('an unsuccessful handover does not start or supersede a run', () => simulate({
		W3N3: room => {
			room['#level'] = 3;
			room['#user'] = room.controller!['#user'] = '101';
			room.controller!['#downgradeTime'] = 100000;
		},
	})(async ({ shard, tick }) => {
		await pushIntentsForRoomNextTick(shard, 'W3N3', '100', {
			local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] }, internal: true,
		});
		await tick(2);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(runKey('100'))), []);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 0);
	}));

	test('a historical outside run cannot score, appear live or trigger global respawn', () => outside(async ({ shard, tick, peekRoom }) => {
		await shard.db.data.hSet(runKey('100'), 'run', '1');
		await shard.db.data.hSet(runKey('100'), 'room', 'W12N1');
		await shard.db.data.hSet(runKey('100'), 'startedTick', '0');
		await shard.data.zAdd(racingKey, [ [ 0, '100:1' ] ]);
		await resetExpiredRuns(shard, 50000);
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].some(object => object['#user'] === '100')), true);
		assert.strictEqual(await captureBracket(shard, '100:1:20000', 20000), undefined);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(scoreKey(20000, '100:1'))), []);
		await shard.data.zAdd(racingKey, [ [ 0, '100:1' ] ]);
		assert.deepStrictEqual(await readRacing(shard, shard.time), []);
		assert.strictEqual(await shard.data.zCard(racingKey), 0);
	}));

	test('an old clock cannot respawn a player whose new outside room was imported directly', () => outside(async ({ shard, tick, peekRoom }) => {
		await startRun(shard, '100', 'W3N3', shard.time);
		await shard.scratch.sAdd(controlledRoomsKey('100'), [ 'W12N1' ]);
		await resetExpiredRuns(shard, 50000);
		await tick();
		assert.strictEqual(await peekRoom('W12N1', room => room['#objects'].some(object => object['#user'] === '100')), true);
		assert.strictEqual(await shard.data.zCard(racingKey), 0);
		assert.strictEqual(await shard.data.zCard(dueRunsKey), 0);
	}));

	test('filtered historical results preserve fallback best, pagination and ranks', () => simulate({})(async ({ shard }) => {
		await seedScore(shard, '100', 1, 'W3N3', 10);
		await seedScore(shard, '100', 2, 'E3N3', 999);
		await seedScore(shard, '101', 1, 'W12N1', 2000);
		await seedScore(shard, '102', 1, 'W7N3', 20);
		const page = await readLeaderboard(shard, 20000, 1, 1);
		assert.strictEqual(page.count, 2);
		assert.deepStrictEqual(page.list.map(entry => [ entry.user, entry.score, entry.rank ]), [ [ '100', 10, 1 ] ]);
		assert.deepStrictEqual(await readPlayerBrackets(shard, '100'), [ { bracket: 20000, score: 10 } ]);
		assert.deepStrictEqual(await readPlayerBrackets(shard, '101'), []);
		const records = await readPlayerRecords(shard, '100', [ 20000 ]);
		assert.deepStrictEqual(records.map(entry => [ entry.record.room, entry.score, entry.rank ]), [ [ 'W3N3', 10, 1 ] ]);
		assert.strictEqual(await shard.db.data.zScore(bestKey(20000), '100'), 999, 'historical data is not deleted by reads');
		assert.strictEqual(await shard.db.data.zCard(rankKey(20000)), 4);
	}));

	test('an out-of-sector historical best does not suppress a new valid best', () => simulate({
		W3N3: room => {
			room['#level'] = 3;
			room['#user'] = room.controller!['#user'] = '100';
			room.controller!['#progress'] = 1000;
			room.controller!['#downgradeTime'] = 100000;
		},
	})(async ({ shard }) => {
		await seedScore(shard, '100', 10, 'E3N3', 999999);
		await shard.db.data.hSet(runKey('100'), 'run', '10');
		assert.strictEqual(await startRun(shard, '100', 'W3N3', shard.time), 11);
		assert.strictEqual(await captureBracket(shard, '100:11:20000', shard.time + 20000), '100:11');
		assert.strictEqual(await shard.db.data.zScore(bestKey(20000), '100'), 46200);
		assert.strictEqual((await readLeaderboard(shard, 20000, 0, 10)).list[0]!.record!.room, 'W3N3');
		assert.strictEqual((await shard.db.data.hGetAll(scoreKey(20000, '100:10'))).room, 'E3N3');
	}));

	test('uniform writes and restore preserve outside terrain including rooms added after backup', () => simulate({})(async ({ shard }) => {
		const original = await shard.loadWorld();
		const oldBefore = new Map([ ...original.terrain ].filter(([ name ]) => isSpeedrunRoom(name))
			.map(([ name, record ]) => [ name, Uint8Array.from(getBuffer(record.terrain)) ]));
		const outsideBefore = Uint8Array.from(getBuffer(original.terrain.get('W12N1')!.terrain));
		const highwayBefore = Uint8Array.from(getBuffer(original.terrain.get('W0N3')!.terrain));
		const outsideBlob = await shard.loadRoomBlob('W12N1');
		const report = await applyUniformTerrain(shard, { terrainType: 1, swampType: 0, sources: 2 });
		assert.strictEqual(report.covered, 72);
		assert.strictEqual(report.ringFaces, 0);
		const stamped = await shard.loadWorld();
		assert.deepStrictEqual(getBuffer(stamped.terrain.get('W12N1')!.terrain), outsideBefore);
		assert.deepStrictEqual(getBuffer(stamped.terrain.get('W0N3')!.terrain), highwayBefore);
		assert.deepStrictEqual(await shard.loadRoomBlob('W12N1'), outsideBlob);
		const changed = new TerrainWriter();
		changed.set(25, 25, TERRAIN_MASK_WALL);
		stamped.terrain.set('E3N3', { ...stamped.terrain.get('W3N3')!, terrain: changed });
		const existingOutside = stamped.terrain.get('W12N1')!.terrain;
		getBuffer(existingOutside)[0] = 85;
		await shard.data.set('terrain', makeWriter(worldSchema)(stamped.terrain));
		await restoreUniform(shard);
		const restored = await shard.loadWorld();
		assert.strictEqual(restored.terrain.get('E3N3')!.terrain.get(25, 25), TERRAIN_MASK_WALL);
		assert.strictEqual(getBuffer(restored.terrain.get('W12N1')!.terrain)[0], 85);
		for (const [ name, terrain ] of oldBefore) {
			assert.deepStrictEqual(getBuffer(restored.terrain.get(name)!.terrain), terrain, name);
		}
	}));

	test('initializers neither close nor paint the new sector', () => simulate({})(async ({ shard }) => {
		const world = await shard.loadWorld();
		const names = new Set(world.terrain.keys());
		for (let xx = 1; xx <= 9; ++xx) {
			for (let yy = 1; yy <= 9; ++yy) {
				names.add(`E${xx}N${yy}`);
			}
		}
		for (const name of names) {
			if (name.startsWith('E')) {
				world.terrain.set(name, { ...computeRoomMeta(name, names), exits: 15, terrain: new TerrainWriter() });
			}
		}
		await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain));
		await shard.data.sAdd('rooms', [ ...names ]);
		await runShardInitializers(shard);
		const after = await shard.loadWorld();
		const open = new Set(await shard.data.sMembers('rooms'));
		assert.strictEqual(open.has('W5N5'), false);
		for (const name of names) {
			if (name.startsWith('E')) {
				assert.ok(open.has(name), `${name} remains open`);
				assert.ok(getBuffer(after.terrain.get(name)!.terrain).every(byte => byte === 0), `${name} remains plain`);
			}
		}
		// The backup is a world blob; the restore path must merge it rather than overwrite a world.
		assert.ok(new World(shard.name, (await shard.data.get(backupKey, { blob: true }))!).terrain.has('E5N5'));
	}));
});

async function seedScore(shard: Shard, userId: string, run: number, room: string, score: number) {
	const bracket = 20000;
	const runId = `${userId}:${run}`;
	await Promise.all([
		...Object.entries({ room, controlPoints: String(score), user: userId, run: String(run), runId, bracket: String(bracket) })
			.map(([ field, value ]) => shard.db.data.hSet(scoreKey(bracket, runId), field, value)),
		shard.db.data.zAdd(rankKey(bracket), [ [ score, runId ] ]),
		shard.db.data.zAdd(playerRunsKey(bracket, userId), [ [ score, String(run) ] ]),
		shard.db.data.zAdd(bestKey(bracket), [ [ score, userId ] ]),
		shard.db.data.hSet(playerBracketsKey(userId), String(bracket), String(score)),
	]);
}
