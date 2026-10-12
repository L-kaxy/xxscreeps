import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { RoomIntentPayload } from 'xxscreeps/engine/processor/room.js';
import type { TickPayload } from 'xxscreeps/engine/runner/index.js';
import type { World } from 'xxscreeps/game/map.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { config } from 'xxscreeps/config/index.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { makeTickPayloadForTesting } from 'xxscreeps/engine/runner/instance.js';
import { GameState, runForPlayer, runOneShot } from 'xxscreeps/game/index.js';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { create as createCreep } from 'xxscreeps/mods/classic/creep/creep.js';
import { Tombstone } from 'xxscreeps/mods/classic/creep/tombstone.js';
import { create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Ruin, createRuin } from 'xxscreeps/mods/classic/structure/ruin.js';
import { claimRuntimeConnector, sandboxRules } from 'xxscreeps/mods/speedrun/game.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { initializeSeason2Map } from './map.js';

const fresh = simulate({});

function withRules(claimController: boolean, ruins: boolean) {
	const settings = config.speedrun!;
	const previous = { claimController: settings.claimController, ruins: settings.ruins };
	const previousSandboxRule = sandboxRules.claimController;
	settings.claimController = claimController;
	settings.ruins = ruins;
	return {
		[Symbol.dispose]() {
			sandboxRules.claimController = previousSandboxRule;
			for (const key of [ 'claimController', 'ruins' ] as const) {
				if (previous[key] === undefined) {
					delete settings[key];
				} else {
					settings[key] = previous[key];
				}
			}
		},
	};
}

async function fixture(shard: Shard, name: string) {
	await initializeSeason2Map(shard, { serverStopped: true });
	const world = await shard.loadWorld();
	const room = await shard.loadRoom(name);
	runOneShot(world, room, shard.time, '', () => {
		if (!room.controller) {
			room['#insertObject'](createRoomObject(new StructureController(), new RoomPosition(33, 32, name)));
			room['#flushObjects'](null);
		}
		room['#user'] = room.controller!['#user'] = null;
		room['#level'] = 0;
		const pos = room.controller!.pos;
		const creep = createCreep(new RoomPosition(pos.x + 1, pos.y, name),
			[ C.CLAIM, C.MOVE, C.WORK, C.CARRY ], 'tester', '100');
		creep.store['#add'](C.RESOURCE_ENERGY, 50);
		room['#insertObject'](creep);
	});
	room['#flushObjects'](null);
	return { world, room };
}

async function process(shard: Shard, world: World, room: Room, intents: Partial<RoomIntentPayload>) {
	const context = new RoomProcessor(shard, world, room, shard.time);
	context.saveIntents('100', { local: {}, object: {}, ...intents });
	await context.process();
	await context.finalize(false);
	shard.time++;
	await shard.data.set('time', shard.time);
	return shard.loadRoom(room.name);
}

describe('global claim and ruin rules', () => {
	test('the registered claim consumer fails closed for missing or malformed payload fields', () => {
		using rules = withRules(false, false);
		for (const value of [ undefined, null, false, 'true', 1 ]) {
			sandboxRules.claimController = true;
			claimRuntimeConnector.receive({ speedrunClaimControllerAllowed: value } as unknown as TickPayload);
			assert.strictEqual(sandboxRules.claimController, false);
		}
		claimRuntimeConnector.receive({} as TickPayload);
		assert.strictEqual(sandboxRules.claimController, false);
		claimRuntimeConnector.receive({ speedrunClaimControllerAllowed: true } as TickPayload);
		assert.strictEqual(sandboxRules.claimController, true);
	});

	for (const name of [ 'W3N3', 'E3N3', 'W12N1', 'W0N0' ]) {
		for (const allowed of [ false, true ]) {
			test(`${name}: claim=${allowed} uses the real payload and processor`, () => fresh(async ({ shard }) => {
				using rules = withRules(allowed, false);
				const { world, room } = await fixture(shard, name);
				const payload = await makeTickPayloadForTesting(shard, world, '100');
				assert.strictEqual(payload.speedrunClaimControllerAllowed, allowed);
				// player() bypasses runtime receive. Exercise the actual registered claim
				// consumer, without invoking unrelated Memory/flag hooks in the host process.
				claimRuntimeConnector.receive(payload);
				const [ intents ] = runForPlayer('100', new GameState(world, shard.time, [ room ]), payload, Game => {
					Game.gcl = { level: 1, progress: 0, progressTotal: C.GCL_MULTIPLY, '#roomCount': 0 };
					assert.strictEqual(Game.creeps.tester!.claimController(room.controller!), allowed ? C.OK : C.ERR_INVALID_TARGET);
					// A normal player intent ensures persistence even when claiming is refused.
					Game.creeps.tester!.say('claim test');
				});
				const queued = intents.getIntentsForRoom(name)!;
				const claims = Object.values(queued.object).filter(value => value && 'claimController' in value);
				assert.strictEqual(claims.length, Number(allowed), 'denial does not record a claim intent');
				const saved = await process(shard, world, room, queued);
				assert.strictEqual(saved['#user'], allowed ? '100' : null);
				assert.strictEqual(saved['#level'], allowed ? 1 : 0);
			}));

			for (const action of [ 'destroyStructure', 'unspawn', 'placeSpawn' ] as const) {
				test(`${name}: ruins=${allowed} covers ${action} and persisted contents`, () => fresh(async ({ shard }) => {
					using rules = withRules(false, allowed);
					const { world, room } = await fixture(shard, name);
					const spawn = runOneShot(world, room, shard.time, '', () => {
						if (action !== 'placeSpawn') {
							room['#user'] = room.controller!['#user'] = '100';
							room['#level'] = 1;
							room.controller!['#downgradeTime'] = shard.time + 10000;
						}
						const spawn = createSpawn(new RoomPosition(25, 25, name),
							action === 'placeSpawn' ? '101' : '100', 'Destroyed');
						spawn.store['#subtract'](C.RESOURCE_ENERGY, spawn.store[C.RESOURCE_ENERGY]);
						spawn.store['#add'](C.RESOURCE_ENERGY, 123);
						room['#insertObject'](spawn);
						return spawn;
					});
					room['#flushObjects'](null);
					let intents: Partial<RoomIntentPayload>;
					if (action === 'unspawn') {
						intents = { local: { unspawn: [ [] ] }, internal: true };
					} else if (action === 'placeSpawn') {
						intents = { local: { placeSpawn: [ [ 25, 26, 'New' ] ] }, internal: true };
					} else {
						intents = { object: { [spawn.id]: { destroyStructure: [ [] ] } } };
					}
					const saved = await process(shard, world, room, intents);
					assert.strictEqual(saved['#objects'].some(object => object.id === spawn.id), false);
					const ruins = saved['#objects'].filter(object => object instanceof Ruin);
					assert.strictEqual(ruins.length, Number(allowed));
					if (allowed) {
						assert.strictEqual(ruins[0]!.store[C.RESOURCE_ENERGY], 123);
						assert.strictEqual(ruins[0]!['#structure'].id, spawn.id);
						if (action === 'unspawn') {
							assert.strictEqual(ruins[0]!['#decayTime'], shard.time + 500000);
						} else if (action === 'placeSpawn') {
							assert.strictEqual(ruins[0]!['#decayTime'], shard.time + 100000);
						}
					}
					if (action === 'unspawn') {
						assert.strictEqual(saved['#user'], null);
					} else if (action === 'placeSpawn') {
						assert.strictEqual(saved['#user'], '100', 'initial landing is not blocked by the claim switch');
					} else {
						const events = runOneShot(world, room, shard.time, '', () => room.getEventLog());
						assert.ok(events.some(event => event.event === C.EVENT_OBJECT_DESTROYED && event.objectId === spawn.id));
					}
				}));
			}

			test(`${name}: ruins=${allowed} never suppresses creep tombstones`, () => fresh(async ({ shard }) => {
				using rules = withRules(false, allowed);
				const { world, room } = await fixture(shard, name);
				const creep = room.find(C.FIND_CREEPS).find(creep => creep.name === 'tester')!;
				const saved = await process(shard, world, room, { object: { [creep.id]: { suicide: [ [] ] } } });
				const tombstones = saved['#objects'].filter(object => object instanceof Tombstone);
				assert.strictEqual(tombstones.length, 1);
				assert.ok(tombstones[0]!.store[C.RESOURCE_ENERGY] >= 50);
			}));
		}

		test(`${name}: turning ruins off does not remove an existing ruin`, () => fresh(async ({ shard }) => {
			using rules = withRules(false, true);
			const { world, room } = await fixture(shard, name);
			const id = runOneShot(world, room, shard.time, '', () => {
				const ruin = createRuin(createSpawn(new RoomPosition(25, 25, name), '100', 'Existing'));
				room['#insertObject'](ruin);
				return ruin.id;
			});
			room['#flushObjects'](null);
			config.speedrun!.ruins = false;
			const creep = room.find(C.FIND_CREEPS).find(creep => creep.name === 'tester')!;
			const saved = await process(shard, world, room, { object: { [creep.id]: { say: [ [ 'persist', false ] ] } } });
			assert.ok(saved['#objects'].some(object => object instanceof Ruin && object.id === id));
		}));

		test(`${name}: reserve, attack and upgrade APIs still work with claiming disabled`, () => fresh(async ({ shard }) => {
			using rules = withRules(false, false);
			const { world, room } = await fixture(shard, name);
			const payload = await makeTickPayloadForTesting(shard, world, '100');
			runForPlayer('100', new GameState(world, shard.time, [ room ]), payload, Game => {
				const creep = Game.creeps.tester!;
				const controller = room.controller!;
				assert.strictEqual(creep.reserveController(controller), C.OK);
				room['#user'] = controller['#user'] = '101';
				room['#level'] = 1;
				assert.strictEqual(creep.attackController(controller), C.OK);
				room['#user'] = controller['#user'] = '100';
				assert.strictEqual(creep.upgradeController(controller), C.OK);
				assert.strictEqual(creep.claimController(controller), C.ERR_INVALID_TARGET);
			});
		}));
	}
});
