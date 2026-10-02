import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { Game, runWithState } from 'xxscreeps/game/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { makeSignedRoomName, parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { TERRAIN_MASK_WALL, getBuffer } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { Structure } from 'xxscreeps/mods/classic/structure/structure.js';
import { computeRoomMeta } from 'xxscreeps/mods/modern/sector/terrain.js';
import { deployStronghold } from 'xxscreeps/mods/modern/stronghold/processor.js';
import { templates } from 'xxscreeps/mods/modern/stronghold/templates.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';
import { challengeLayout, challengeTerrain, isChallengeHome, kExitEnd, kExitStart } from './layout.js';
import { loadChallengePair, prepareStrongholdChallenge, preparedKey, restoreStrongholdChallenge } from './setup.js';
import { guardPreparedMain, isMainServiceEntry } from './startup.js';
import { createStronghold } from './stronghold.js';
import './main.js';

function sector(west: boolean) {
	const names = new Set(Array.from({ length: 121 }, (__unused, ii) =>
		makeSignedRoomName(west ? -(ii % 11) - 1 : ii % 11, west ? -Math.floor(ii / 11) - 1 : Math.floor(ii / 11))));
	return new Map([ ...names ].map(name => [ name, computeRoomMeta(name, names) ]));
}

describe('stronghold challenge map', () => {
	test('startup gating only installs for main service entry commands', () => {
		for (const command of [ 'main', 'start', import.meta.resolve('xxscreeps/engine/service/main.js'), import.meta.resolve('xxscreeps/engine/service/launcher.js') ]) {
			assert.strictEqual(isMainServiceEntry(command), true);
		}
		for (const command of [ undefined, 'prepare-stronghold', 'test', 'processor', 'runner', 'backend' ]) {
			assert.strictEqual(isMainServiceEntry(command), false);
		}
	});

	test('startup requires an explicitly prepared map, and restoration revokes readiness', () => simulate({})(async ({ shard }) => {
		async function attemptStartup(ready: boolean) {
			{
				await using main = guardPreparedMain(await Mutex.connect('main', shard.data, shard.pubsub), shard.data);
				if (ready) {
					await using lock = await main.acquire();
					assert.notStrictEqual(await shard.data.get('mutex/main'), null);
				} else {
					await assert.rejects(() => main.acquire(), /Prepare the stronghold challenge map offline/);
				}
			}
			assert.strictEqual(await shard.data.get('mutex/main'), null);
		}
		await attemptStartup(false);
		await prepareStrongholdChallenge(shard);
		await attemptStartup(true);
		await restoreStrongholdChallenge(shard);
		await attemptStartup(false);
	}));

	test('each row has four geographic left/right pairs and an unused room', () => {
		for (const west of [ false, true ]) {
			const terrain = sector(west);
			const layout = challengeLayout(terrain);
			assert.strictEqual(layout.pairs.length, 36);
			assert.strictEqual(layout.unused.length, 9);
			const used = new Set(layout.pairs.flatMap(pair => [ pair.home, pair.stronghold ]));
			assert.strictEqual(used.size, 72);
			assert.strictEqual(new Set([ ...used, ...layout.unused ]).size, 81);
			for (const pair of layout.pairs) {
				const home = parseSignedRoomName(pair.home);
				const stronghold = parseSignedRoomName(pair.stronghold);
				assert.strictEqual(stronghold.rx, home.rx + 1);
				assert.strictEqual(stronghold.ry, home.ry);
			}
		}
	});

	test('incomplete and multiple sectors are rejected', () => {
		const terrain = sector(false);
		terrain.delete('E1S1');
		assert.throws(() => challengeLayout(terrain), /complete 9x9 square/);
		assert.throws(() => challengeLayout(new Map()), /exactly one complete/);
		assert.throws(() => challengeLayout(new Map([ ...sector(false), ...sector(true) ])), /exactly one complete/);
	});

	test('only the shared face opens and every other border tile remains a wall', () => {
		const layout = challengeLayout(sector(false));
		for (const pair of layout.pairs) {
			const left = challengeTerrain(pair.home, pair);
			const right = challengeTerrain(pair.stronghold, pair);
			assert.strictEqual(left.exits, 2);
			assert.strictEqual(right.exits, 8);
			for (let ii = 0; ii < 50; ++ii) {
				const shared = ii >= kExitStart && ii <= kExitEnd ? 0 : TERRAIN_MASK_WALL;
				assert.strictEqual(left.terrain.get(49, ii), shared);
				assert.strictEqual(right.terrain.get(0, ii), shared);
				for (const record of [ left, right ]) {
					assert.strictEqual(record.terrain.get(ii, 0), TERRAIN_MASK_WALL);
					assert.strictEqual(record.terrain.get(ii, 49), TERRAIN_MASK_WALL);
				}
				assert.strictEqual(left.terrain.get(0, ii), TERRAIN_MASK_WALL);
				assert.strictEqual(right.terrain.get(49, ii), TERRAIN_MASK_WALL);
			}
		}
		assert.strictEqual(challengeTerrain(layout.unused[0]!).exits, 0);
	});

	test('preparation stamps roles and both room slots, with exact rollback', () => simulate({})(async ({ shard }) => {
		const originalTerrain = Uint8Array.from(await shard.data.req('terrain', { blob: true }));
		const original = await shard.loadWorld();
		const layout = challengeLayout(original.terrain);
		const name = layout.pairs[0]!.home;
		// A closed room and a missing inactive buffer must remain recoverable as authored.
		await shard.data.sRem('rooms', [ name ]);
		await shard.data.del(`room1/${name}`);
		const originalRooms = await shard.data.sMembers('rooms');
		const slots = await Promise.all([ ...original.terrain.keys() ].flatMap(roomName => [ 0, 1 ].map(async slot => ({
			key: `room${slot}/${roomName}`, blob: await shard.data.get(`room${slot}/${roomName}`, { blob: true }),
		}))));
		const dry = await prepareStrongholdChallenge(shard, { dryRun: true });
		assert.strictEqual(dry.written, false);
		assert.strictEqual(await shard.data.get(preparedKey), null);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), originalTerrain);
		const report = await prepareStrongholdChallenge(shard);
		assert.strictEqual(report.pairs.length, 36);
		assert.strictEqual(await shard.data.get(preparedKey), '1');
		const world = await shard.loadWorld();
		const pair = report.pairs[0]!;
		assert.strictEqual(world.map.getRoomStatus(name).status, 'normal');
		const home = await shard.loadRoom(pair.home);
		const target = await shard.loadRoom(pair.stronghold);
		assert.deepStrictEqual(home['#challengePair'], pair);
		assert.deepStrictEqual(target['#challengePair'], pair);
		assert.deepStrictEqual(await loadChallengePair(shard, pair.stronghold), pair);
		assert.strictEqual(isChallengeHome(home), true);
		assert.strictEqual(isChallengeHome(target), false);
		for (const [ roomName, record ] of world.terrain) {
			const room = await shard.loadRoom(roomName);
			if (isChallengeHome(room)) {
				assert.ok(room.controller instanceof StructureController);
				assert.strictEqual(room['#objects'].length, 1);
			} else {
				assert.strictEqual(room.controller, undefined);
				assert.strictEqual(room['#user'], undefined);
				assert.strictEqual(room['#objects'].length, 0);
			}
			if (room['#challengePair'] === undefined) {
				assert.strictEqual(record.exits, 0, `${roomName} is isolated`);
			}
		}
		assert.deepStrictEqual(getBuffer(world.terrain.get(pair.stronghold)!.terrain), getBuffer(challengeTerrain(pair.stronghold, pair).terrain));
		await assert.rejects(() => prepareStrongholdChallenge(shard), /already prepared/);
		assert.strictEqual(await restoreStrongholdChallenge(shard), true);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), originalTerrain);
		assert.deepStrictEqual((await shard.data.sMembers('rooms')).sort(), originalRooms.sort());
		for (const { key, blob } of slots) {
			assert.deepStrictEqual(await shard.data.get(key, { blob: true }), blob);
		}
		assert.strictEqual(await loadChallengePair(shard, name), undefined);
		assert.strictEqual(await shard.data.get(preparedKey), null);
	}));

	test('a preparation interrupted after backup can still be restored', () => simulate({})(async ({ shard }) => {
		const terrain = Uint8Array.from(await shard.data.req('terrain', { blob: true }));
		await prepareStrongholdChallenge(shard);
		// The completed marker is the last preparation write. Its absence simulates a prior failure.
		await shard.data.del(preparedKey);
		await assert.rejects(() => prepareStrongholdChallenge(shard), /unfinished challenge preparation/);
		assert.strictEqual(await restoreStrongholdChallenge(shard), true);
		assert.deepStrictEqual(await shard.data.req('terrain', { blob: true }), terrain);
		assert.strictEqual(await restoreStrongholdChallenge(shard), false);
		assert.strictEqual((await prepareStrongholdChallenge(shard, { dryRun: true })).written, false);
	}));

	test('preparation refuses a running main service without waiting', () => simulate({})(async ({ shard }) => {
		await using main = await Mutex.connect('main', shard.data, shard.pubsub);
		await using lock = await main.acquire();
		await assert.rejects(() => prepareStrongholdChallenge(shard), /Stop the running game services/);
		assert.strictEqual(await shard.data.get(preparedKey), null);
	}));

	test('preparation refuses a world with player presence', () => simulate({
		W1N1: room => {
			room['#user'] = '100';
			room['#level'] = 1;
			room.controller!['#user'] = '100';
		},
	})(async ({ shard }) => {
		await assert.rejects(() => prepareStrongholdChallenge(shard), /players are present/);
		assert.strictEqual(await shard.data.get(preparedKey), null);
	}));

	test('restoration refuses to overwrite a player who landed after preparation', () => simulate({})(async ({ shard }) => {
		const { pairs } = await prepareStrongholdChallenge(shard);
		const name = pairs[0]!.home;
		const room = await shard.loadRoom(name);
		room['#user'] = '100';
		room['#level'] = 8;
		room.controller!['#user'] = '100';
		await shard.saveRoom(name, shard.time, room);
		await assert.rejects(() => restoreStrongholdChallenge(shard), /players are present/);
		assert.strictEqual(await shard.data.get(preparedKey), '1');
		assert.strictEqual((await shard.loadRoom(name))['#user'], '100');
	}));

	test('invalid stronghold creation leaves the room pristine', () => simulate({})(async ({ shard }) => {
		const { pairs } = await prepareStrongholdChallenge(shard);
		const room = await shard.loadRoom(pairs[0]!.stronghold);
		const world = await shard.loadWorld();
		const context = new RoomProcessor(shard, world, room, shard.time);
		runWithState(context.state, () => {
			const options = { position: new RoomPosition(25, 25, room.name), level: 5, templateName: 'bunker5' as const };
			assert.throws(() => createStronghold(room, context, { ...options, position: new RoomPosition(1, 1, room.name) }), /fit on walkable/);
			assert.throws(() => createStronghold(room, context, { ...options, level: 4 }), /must agree/);
			assert.throws(() => createStronghold(room, context, { ...options, deployTime: Game.time }), /future tick/);
			assert.strictEqual([ ...room['#immediateObjects']() ].length, 0);
			assert.strictEqual(room['#npcData'].users.size, 0);
		});
	}));

	test('immediate and timed strongholds use the same complete bunker and lifetime', () => simulate({})(async ({ shard }) => {
		const { pairs } = await prepareStrongholdChallenge(shard);
		const world = await shard.loadWorld();
		for (const [ index, pair ] of pairs.slice(0, 2).entries()) {
			const room = await shard.loadRoom(pair.stronghold);
			const context = new RoomProcessor(shard, world, room, shard.time);
			runWithState(context.state, () => {
				const core = createStronghold(room, context, {
					position: new RoomPosition(25, 25, room.name), level: 5, templateName: 'bunker5',
					...index === 0 ? {} : { deployTime: Game.time + 100 },
				});
				if (index === 1) {
					assert.strictEqual(core['#collapseTime'], 0);
					assert.strictEqual([ ...room['#immediateObjects']() ].length, 1);
					deployStronghold(core, context);
				}
				room['#flushObjects'](context.state);
				assert.strictEqual(core['#deployTime'], 0);
				assert.strictEqual(room['#objects'].length, templates.bunker5.structures.length + 1);
				assert.strictEqual(room['#objects'].filter(object => object instanceof Structure && object['#collapseTime'] === core['#collapseTime']).length, room['#objects'].length);
				const duration = core['#collapseTime'] - Game.time;
				assert.ok(duration >= Math.round(C.STRONGHOLD_DECAY_TICKS * 0.9));
				assert.ok(duration <= Math.round(C.STRONGHOLD_DECAY_TICKS * 1.1));
				assert.ok(room['#npcData'].users.has('2'));
			});
		}
	}));
});
