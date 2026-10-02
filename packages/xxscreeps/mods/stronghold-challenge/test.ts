import type { ChallengePair } from './layout.js';
import { loadTerrain } from 'xxscreeps/driver/pathfinder/pathfinder.js';
import { pushIntentsForRoomNextTick } from 'xxscreeps/engine/processor/model.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { resetController } from 'xxscreeps/mods/classic/controller/controller.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Structure } from 'xxscreeps/mods/classic/structure/structure.js';
import { StructureInvaderCore } from 'xxscreeps/mods/modern/stronghold/invader-core.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { PWR_OPERATE_SPAWN } from './constants.js';
import { challengeLayout } from './layout.js';
import { activeKey, dueKey, runKey } from './race.js';
import { challengeRankingKeys } from './ranking.js';
import { readRankedRuns, readRunRanking } from './runs.js';
import { prepareStrongholdChallenge } from './setup.js';
import './backend-test.js';
import './layout-test.js';
import './ranking-test.js';

async function arena(body: Parameters<ReturnType<typeof simulate>>[0]) {
	await simulate({}, async shard => { await prepareStrongholdChallenge(shard); })(async refs => {
		const original = new Map(refs.world.terrain);
		const prepared = await refs.shard.loadWorld();
		for (const [ name, traits ] of prepared.terrain) {
			refs.world.terrain.set(name, traits);
		}
		loadTerrain(refs.world);
		try {
			await body(refs);
		} finally {
			refs.world.terrain.clear();
			for (const [ name, traits ] of original) {
				refs.world.terrain.set(name, traits);
			}
			loadTerrain(refs.world);
		}
	});
}

function pairsOf(world: Parameters<Parameters<ReturnType<typeof simulate>>[0]>[0]['world']) {
	return challengeLayout(world.terrain).pairs;
}

async function land(shard: Parameters<Parameters<ReturnType<typeof simulate>>[0]>[0]['shard'], pair: ChallengePair) {
	await pushIntentsForRoomNextTick(shard, pair.home, '100', {
		internal: true, local: { placeSpawn: [ [ 25, 25, 'Spawn1' ] ] },
	});
}

describe('stronghold challenge race', () => {
	test('ordinary rooms retain energy costs, normal incubation and unboosted births', () => simulate({
		W1N1: room => {
			room['#insertObject'](createSpawn(new RoomPosition(25, 25, room.name), '100', 'Spawn1'));
			room['#level'] = 8;
			room['#user'] = room.controller!['#user'] = '100';
		},
	})(async ({ player, tick }) => {
		await player('100', Game => {
			assert.strictEqual(Game.spawns.Spawn1!.effects, undefined);
			assert.strictEqual(Game.spawns.Spawn1!.spawnCreep(Array.from({ length: 7 }, () => C.MOVE), 'expensive'), C.ERR_NOT_ENOUGH_ENERGY);
			assert.strictEqual(Game.spawns.Spawn1!.spawnCreep([ C.MOVE ], 'normal'), C.OK);
		});
		await tick();
		await player('100', Game => {
			assert.strictEqual(Game.spawns.Spawn1!.spawning!.needTime, C.CREEP_SPAWN_TIME);
			assert.ok(Game.spawns.Spawn1!.store.energy < C.SPAWN_ENERGY_START);
		});
		await tick(C.CREEP_SPAWN_TIME - 1);
		await player('100', Game => {
			assert.strictEqual(Game.creeps.normal!.spawning, false);
			assert.ok(Game.creeps.normal!.body.every(part => part.boost === undefined));
		});
	}));

	test('landing grants RCL8, three free accelerated spawns and a complete level5 core', () => arena(async ({ shard, world, player, tick, peekRoom }) => {
		const pair = pairsOf(world)[0]!;
		await land(shard, pair);
		await tick(2);
		await player('100', Game => {
			assert.strictEqual(Game.rooms[pair.home]!.controller!.level, 8);
			assert.strictEqual(Object.values(Game.spawns).length, 3);
			for (const spawn of Object.values(Game.spawns)) {
				assert.strictEqual(spawn.store.energy, 300);
				assert.deepStrictEqual(spawn.effects, [ { effect: PWR_OPERATE_SPAWN, level: 5 } ]);
			}
			const body = [ C.ATTACK, C.RANGED_ATTACK, C.HEAL, C.MOVE, C.TOUGH, C.CARRY, C.WORK, C.CLAIM ];
			assert.strictEqual(Game.spawns.Spawn1!.spawnCreep(body, 'squad'), C.OK);
		});
		await tick();
		await player('100', Game => {
			assert.strictEqual(Game.spawns.Spawn1!.spawning!.needTime, 5);
			assert.strictEqual(Game.spawns.Spawn1!.store.energy, 300);
			assert.ok(Game.creeps.squad!.body.every(part => part.boost === undefined));
		});
		await tick(4);
		await player('100', Game => {
			const creep = Game.creeps.squad!;
			assert.strictEqual(creep.spawning, false);
			assert.deepStrictEqual(creep.body.map(part => part.boost), [ 'XUH2O', 'XKHO2', 'XLHO2', 'XZHO2', 'XGHO2', 'XKH2O', 'XZH2O', undefined ]);
			assert.strictEqual(creep.store.getCapacity(), 200);
		});
		await peekRoom(pair.stronghold, room => {
			assert.strictEqual(room.controller, undefined);
			const core = room['#objects'].find((object): object is StructureInvaderCore => object instanceof StructureInvaderCore)!;
			assert.strictEqual(core.level, 5);
			assert.strictEqual(core['#deployTime'], 0);
			assert.strictEqual(room['#challengeRun']!.coreId, core.id);
			assert.ok(room['#objects'].some(object => object instanceof Structure && object.structureType === C.STRUCTURE_TOWER));
		});
	}));

	test('manual respawn clears the whole pair without target player presence and a new landing resets its core', () => arena(async ({ shard, world, tick, peekRoom }) => {
		const pair = pairsOf(world)[0]!;
		await land(shard, pair);
		await tick(2);
		const first = await shard.data.hGetAll(runKey('100'));
		await respawnPlayer(shard, '100');
		await tick();
		await peekRoom(pair.home, room => {
			assert.strictEqual(room.controller!.level, 0);
			assert.strictEqual(room['#objects'].length, 1);
			assert.strictEqual(room['#challengeHomeRun'], undefined);
		});
		await peekRoom(pair.stronghold, room => {
			assert.strictEqual(room['#objects'].length, 0, JSON.stringify(room['#objects'].map(object => ({ type: object.constructor.name, id: object.id }))));
			assert.strictEqual(room['#challengeRun'], undefined);
			assert.strictEqual(room['#npcData'].users.size, 0);
		});
		assert.deepStrictEqual(await shard.data.sMembers(activeKey), []);
		await land(shard, pair);
		await tick(2);
		const second = await shard.data.hGetAll(runKey('100'));
		assert.notStrictEqual(second.coreId, first.coreId);
		assert.notStrictEqual(second.runId, first.runId);
		assert.strictEqual(second.state, 'running');
	}));

	test('combat victory records elapsed ticks once and survives the later automatic respawn', () => arena(async ({ shard, world, tick, player, poke, peekRoom }) => {
		const pair = pairsOf(world)[0]!;
		await land(shard, pair);
		await tick(2);
		const coreId = await poke(pair.stronghold, '100', (_Game, room) => {
			const core = room['#objects'].find((object): object is StructureInvaderCore => object instanceof StructureInvaderCore)!;
			for (const object of room['#objects']) {
				if (object !== core) {
					room['#removeObject'](object);
				}
			}
			core.hits = 1;
			room['#insertObject'](createCreep(new RoomPosition(25, 24, room.name), [ C.ATTACK, C.MOVE ], 'finisher', '100'));
			return core.id;
		});
		await player('100', Game => {
			assert.strictEqual(Game.creeps.finisher!.attack(Game.getObjectById<StructureInvaderCore>(coreId)!), C.OK);
		});
		await tick();
		const keys = challengeRankingKeys(shard.name);
		const records = await readRankedRuns(shard.db.data, keys, 'ascending', '100');
		assert.strictEqual(records.length, 1);
		assert.strictEqual(records[0]!.score, 1);
		assert.strictEqual(records[0]!.fields.finishedTick, String(shard.time));
		assert.strictEqual((await shard.data.hGetAll(runKey('100'))).state, 'won');
		await tick(2);
		assert.strictEqual((await readRunRanking(shard.db.data, keys, 'ascending', 0, 10)).count, 1);
		const deadline = shard.time + 1;
		await poke(pair.stronghold, undefined, (_Game, room) => {
			room['#challengeRun']!.deadlineTick = deadline;
		});
		await shard.data.zAdd(dueKey, [ [ deadline, (await shard.data.hGetAll(runKey('100'))).runId! ] ]);
		await tick(2);
		await peekRoom(pair.home, room => assert.strictEqual(room.controller!.level, 0));
		await peekRoom(pair.stronghold, room => assert.strictEqual(room['#objects'].length, 0));
		assert.strictEqual((await readRankedRuns(shard.db.data, keys, 'ascending', '100')).length, 1);
	}));

	test('natural expiry respawns offline players and never scores a vanished core', () => arena(async ({ shard, world, tick, poke, peekRoom }) => {
		const pair = pairsOf(world)[0]!;
		await land(shard, pair);
		await tick(2);
		const deadline = shard.time + 1;
		await poke(pair.stronghold, undefined, (_Game, room) => {
			room['#challengeRun']!.deadlineTick = deadline;
			for (const object of room['#objects']) {
				if (object instanceof Structure) {
					object['#collapseTime'] = deadline;
				}
			}
		});
		// The timer projection is authored together with the room in production.
		const runId = (await shard.data.hGetAll(runKey('100'))).runId!;
		await shard.data.zAdd(dueKey, [ [ deadline, runId ] ]);
		await tick(2);
		await peekRoom(pair.home, room => assert.strictEqual(room.controller!.level, 0));
		await peekRoom(pair.stronghold, room => assert.strictEqual(room['#objects'].length, 0));
		assert.strictEqual(await shard.db.data.zCard(challengeRankingKeys(shard.name).best), 0);
	}));

	test('empty player objects still reset and a superseded pair cannot reset a later landing', () => arena(async ({ shard, world, tick, poke, peekRoom }) => {
		const [ pair, next ] = pairsOf(world);
		await land(shard, pair!);
		await tick(2);
		const previousRunId = (await shard.data.hGetAll(runKey('100'))).runId!;
		await poke(pair!.home, undefined, (_Game, room) => {
			resetController(room.controller!);
			for (const object of room['#objects']) {
				if (object !== room.controller) {
					room['#removeObject'](object);
				}
			}
		});
		await respawnPlayer(shard, '100');
		await tick(2);
		await peekRoom(pair!.stronghold, room => assert.strictEqual(room['#objects'].length, 0, JSON.stringify(room['#objects'].map(object => ({ type: object.constructor.name, id: object.id })))));
		await land(shard, next!);
		await tick(2);
		// An old timer already queued by another worker must not respawn the replacement run.
		await shard.data.zAdd(dueKey, [ [ shard.time + 1, previousRunId ] ]);
		await pushIntentsForRoomNextTick(shard, next!.stronghold, '100', {
			internal: true, local: { resetStrongholdChallenge: [ [ previousRunId ] ] },
		});
		await tick(2);
		await peekRoom(next!.stronghold, room => assert.strictEqual(room['#challengeRun']!.state, 'running'));
		await peekRoom(next!.home, room => assert.strictEqual(room.controller!.level, 8));
	}));

	test('two simultaneous landings establish exactly one challenge for a player', () => arena(async ({ shard, world, tick, peekRoom }) => {
		const [ first, second ] = pairsOf(world);
		await land(shard, first!);
		await land(shard, second!);
		await tick(2);
		const run = await shard.data.hGetAll(runKey('100'));
		assert.strictEqual(run.state, 'running');
		const ownership = await Promise.all([ first!, second! ].map(pair => peekRoom(pair.home, room => room.controller!.level)));
		assert.deepStrictEqual(ownership.sort((left, right) => left - right), [ 0, 8 ]);
		const targets = await Promise.all([ first!, second! ].map(pair => peekRoom(pair.stronghold, room => room['#challengeRun'])));
		assert.strictEqual(targets.filter(Boolean).length, 1);
	}));
});
