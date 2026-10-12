import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { World } from 'xxscreeps/game/map.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config } from 'xxscreeps/config/index.js';
import { acquireIntentsForRoom } from 'xxscreeps/engine/processor/model.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { runShardTickProcessors } from 'xxscreeps/engine/processor/shard.js';
import { runOneShot } from 'xxscreeps/game/index.js';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { createRace, makeRaceKeys } from 'xxscreeps/mods/speedrun/race-core.js';
import { activeRunKey, isCurrentSeasonRun } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import * as Season1 from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { initializeSeason2Map } from './map.js';
import * as Season2 from './race.js';

const fresh = simulate({});
const keys2 = makeRaceKeys('speedrun-season2');
const command = promisify(execFile);
const binary = fileURLToPath(new URL('../../../xxscreeps.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../test/data/shard.json', import.meta.url));

async function worldOf(shard: Shard) {
	await initializeSeason2Map(shard, { serverStopped: true });
	return shard.loadWorld();
}

/** Exercise actual handover/unspawn and persist each resulting room tick. */
async function processRoom(shard: Shard, world: World, name: string, unspawn = false, user = '100') {
	const room = await shard.loadRoom(name);
	const context = new RoomProcessor(shard, world, room, shard.time);
	if (unspawn) {
		context.saveIntents(user, { local: { unspawn: [ [] ] }, object: {}, internal: true });
	} else {
		const terrain = world.terrain.get(name)!.terrain;
		let tile: [ number, number ] | undefined;
		for (let yy = 2; yy < 48 && !tile; ++yy) {
			for (let xx = 2; xx < 48; ++xx) {
				if (!(terrain.get(xx, yy) & 1) && !room['#objects'].some(object => object.pos.x === xx && object.pos.y === yy)) {
					tile = [ xx, yy ];
					break;
				}
			}
		}
		assert.ok(tile);
		context.saveIntents(user, { local: { placeSpawn: [ [ ...tile, 'Spawn1' ] ] }, object: {}, internal: true });
	}
	await context.process();
	await context.finalize(false);
	++shard.time;
	await shard.data.set('time', shard.time);
	return shard.loadRoom(name);
}

async function active(shard: Shard, user = '100') {
	return JSON.parse(await shard.db.data.req(activeRunKey(user))) as { namespace: string; active: boolean; run: string };
}

async function emptyQueue(shard: Shard, season: { racingKey: string; dueRunsKey: string }) {
	assert.strictEqual(await shard.data.zCard(season.racingKey), 0);
	assert.strictEqual(await shard.data.zCard(season.dueRunsKey), 0);
}

describe('season-2 lifecycle', () => {
	test('a successful E3N3 handover uses its exact game tick and independent default brackets', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		const started = shard.time + 1;
		await processRoom(shard, world, 'E3N3');
		assert.deepStrictEqual({ ...await shard.db.data.hGetAll(Season2.runKey('100')) }, {
			run: '1', room: 'E3N3', startedTick: String(started),
		});
		assert.deepStrictEqual(await shard.data.zRangeWithScores(Season2.racingKey, 0, -1), [ [ started, '100:1' ] ]);
		assert.deepStrictEqual(await shard.data.zRangeWithScores(Season2.dueRunsKey, 0, -1),
			Season2.raceBrackets().map(bracket => [ started + bracket, `100:1:${bracket}` ]));
		await emptyQueue(shard, Season1);
		assert.strictEqual((await active(shard)).namespace, 'speedrun-season2');
		assert.strictEqual(await shard.db.data.zCard(keys2.bestKey(20000)), 0);
	}));

	test('an already-owned room cannot start another run', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		await processRoom(shard, world, 'E3N3');
		const before = await shard.db.data.hGetAll(Season2.runKey('100'));
		await processRoom(shard, world, 'E3N3');
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season2.runKey('100')), before);
		assert.strictEqual(await shard.data.zCard(Season2.racingKey), 1);
	}));

	for (const reverse of [ false, true ]) {
		const from = reverse ? Season2 : Season1;
		const to = reverse ? Season1 : Season2;
		const roomFrom = reverse ? 'E3N3' : 'W3N3';
		const roomTo = reverse ? 'W3N3' : 'E3N3';
		test(`${roomFrom} to ${roomTo} ends only the old clock after ordinary unspawn and successful landing`, () => fresh(async ({ shard }) => {
			const world = await worldOf(shard);
			await processRoom(shard, world, roomFrom);
			await processRoom(shard, world, roomFrom, true);
			assert.strictEqual((await shard.loadRoom(roomFrom))['#user'], null);
			const tick = shard.time + 1;
			assert.strictEqual((await processRoom(shard, world, roomTo))['#user'], '100');
			const ended = await shard.db.data.hGetAll(from.runKey('100'));
			assert.strictEqual(ended.run, '1');
			assert.strictEqual(ended.endedTick, String(tick));
			await emptyQueue(shard, from);
			assert.deepStrictEqual({ ...await shard.db.data.hGetAll(to.runKey('100')) }, {
				run: '1', room: roomTo, startedTick: String(tick),
			});
			assert.strictEqual((await active(shard)).namespace, reverse ? 'speedrun' : 'speedrun-season2');
		}));
	}

	test('returning to season 2 increments only its own run number', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		for (const name of [ 'E3N3', 'W3N3', 'E3N3' ]) {
			await processRoom(shard, world, name);
			await processRoom(shard, world, name, true);
		}
		assert.strictEqual(await shard.db.data.hGet(Season2.runKey('100'), 'run'), '2');
		assert.strictEqual(await shard.db.data.hGet(Season1.runKey('100'), 'run'), '1');
		assert.deepStrictEqual(await shard.data.zRange(Season2.racingKey, 0, -1), [ '100:2' ]);
		await emptyQueue(shard, Season1);
	}));

	test('switching in either direction preserves all historical result keys and indexes', () => fresh(async ({ shard }) => {
		const tables = [ makeRaceKeys('speedrun'), keys2 ];
		for (const keys of tables) {
			await shard.db.data.hSet(keys.scoreKey(20000, '100:7'), 'controlPoints', '46200');
			await shard.db.data.zAdd(keys.rankKey(20000), [ [ 46200, '100:7' ] ]);
			await shard.db.data.zAdd(keys.bestKey(20000), [ [ 46200, '100' ] ]);
			await shard.db.data.zAdd(keys.playerRunsKey(20000, '100'), [ [ 46200, '7' ] ]);
			await shard.db.data.hSet(keys.playerBracketsKey('100'), '20000', '46200');
		}
		await Season1.startRun(shard, '100', 'W3N3', 10);
		await Season2.startRun(shard, '100', 'E3N3', 11);
		await Season1.startRun(shard, '100', 'W3N3', 12);
		for (const keys of tables) {
			assert.strictEqual(await shard.db.data.hGet(keys.scoreKey(20000, '100:7'), 'controlPoints'), '46200');
			assert.deepStrictEqual(await shard.db.data.zRange(keys.rankKey(20000), 0, -1), [ '100:7' ]);
			assert.deepStrictEqual(await shard.db.data.zRange(keys.bestKey(20000), 0, -1), [ '100' ]);
			assert.deepStrictEqual(await shard.db.data.zRange(keys.playerRunsKey(20000, '100'), 0, -1), [ '7' ]);
			assert.strictEqual(await shard.db.data.hGet(keys.playerBracketsKey('100'), '20000'), '46200');
		}
	}));

	test('stale season-1 captures and expired retries cannot respawn a current season-2 player', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		await processRoom(shard, world, 'W3N3');
		const oldRoom = await shard.loadRoom('W3N3');
		oldRoom['#level'] = 2;
		oldRoom.controller!['#downgradeTime'] = 100000;
		await shard.saveRoom(oldRoom.name, shard.time, oldRoom);
		// Internal/admin fixture deliberately leaves an old scoreable room behind.
		await processRoom(shard, world, 'E3N3');
		await shard.saveRoom(oldRoom.name, shard.time, oldRoom);
		assert.strictEqual((await shard.loadRoom(oldRoom.name)).controller?.level, 2);
		// A missing scratch relationship must not bypass the persistent activity guard.
		await shard.scratch.del(controlledRoomsKey('100'));
		// Simulate a delayed/replayed old queue, even with its ended mark missing.
		await shard.db.data.hDel(Season1.runKey('100'), [ 'endedTick' ]);
		await shard.data.zAdd(Season1.racingKey, [ [ 0, '100:1' ] ]);
		await shard.data.zAdd(Season1.dueRunsKey, [ [ 20000, '100:1:20000' ] ]);
		await Season1.captureDueBrackets(shard, 20000);
		await shard.db.data.hDel(Season1.runKey('100'), [ 'endedTick' ]);
		await shard.data.zAdd(Season1.racingKey, [ [ 0, '100:1' ] ]);
		await Season1.resetExpiredRuns(shard, 50000);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'W3N3'), []);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Season1.scoreKey(20000, '100:1'))), []);
		assert.ok((await shard.loadRoom('E3N3'))['#objects'].some(object => object instanceof StructureSpawn));
		assert.strictEqual((await active(shard)).namespace, 'speedrun-season2');
		await emptyQueue(shard, Season1);
	}));

	test('the persistent guard rejects an old season-2 task after switching back', () => fresh(async ({ shard }) => {
		await Season2.startRun(shard, '100', 'E3N3', 10);
		const old = await shard.db.data.hGetAll(Season2.runKey('100'));
		await Season1.startRun(shard, '100', 'W3N3', 11);
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun-season2', '100', old), false);
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun', '100',
			await shard.db.data.hGetAll(Season1.runKey('100'))), true);
	}));

	test('a legacy season-1 clock remains valid without metadata, then stops safely on switching', () => fresh(async ({ shard }) => {
		const legacy = createRace({
			namespace: 'speedrun', containsRoom: () => true, getSettings: () => ({ raceBrackets: [ 20000, 40000 ] }),
		});
		await legacy.startRun(shard, '100', 'W3N3', 0);
		const info = await shard.db.data.hGetAll(Season1.runKey('100'));
		assert.strictEqual(await shard.db.data.get(activeRunKey('100')), null);
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun', '100', info), true);
		await Season2.startRun(shard, '100', 'E3N3', 10);
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun', '100', info), false);
		await emptyQueue(shard, Season1);
	}));

	test('explicit stop retains an inactive marker so a stale retry cannot become a legacy clock', () => fresh(async ({ shard }) => {
		await Season1.startRun(shard, '100', 'W3N3', 0);
		const info = await shard.db.data.hGetAll(Season1.runKey('100'));
		await Season1.stopRun(shard, '100', 1);
		assert.strictEqual((await active(shard)).active, false);
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun', '100', info), false);
		await shard.db.data.hDel(Season1.runKey('100'), [ 'endedTick' ]);
		await shard.data.zAdd(Season1.racingKey, [ [ 0, '100:1' ] ]);
		await Season1.resetExpiredRuns(shard, 40000);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'W3N3'), []);
	}));

	test('the guard compares namespace, room, tick, run and shard, not merely user:run', () => fresh(async ({ shard }) => {
		await Season2.startRun(shard, '100', 'E3N3', 10);
		const info = await shard.db.data.hGetAll(Season2.runKey('100'));
		for (const changed of [ { run: '2' }, { room: 'E2N3' }, { startedTick: '11' } ]) {
			assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun-season2', '100', { ...info, ...changed }), false);
		}
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun', '100', info), false);
		const marker = JSON.parse(await shard.db.data.req(activeRunKey('100'))) as Record<string, unknown>;
		await shard.db.data.set(activeRunKey('100'), JSON.stringify({ ...marker, shard: 'other-shard' }));
		assert.strictEqual(await isCurrentSeasonRun(shard, 'speedrun-season2', '100', info), false);
	}));

	test('cross-season cancellation only removes this player, never another player or history', () => fresh(async ({ shard }) => {
		await Season1.startRun(shard, '101', 'W4N3', 1);
		await Season1.startRun(shard, '100', 'W3N3', 1);
		const other = await shard.db.data.hGetAll(Season1.runKey('101'));
		await Season2.startRun(shard, '100', 'E3N3', 2);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season1.runKey('101')), other);
		assert.deepStrictEqual(await shard.data.zRange(Season1.racingKey, 0, -1), [ '101:1' ]);
		assert.deepStrictEqual(await shard.data.zRange(Season1.dueRunsKey, 0, -1), [ '101:1:20000', '101:1:40000' ]);
		assert.strictEqual((await active(shard, '101')).namespace, 'speedrun');
	}));

	test('concurrent starts serialize lifecycle writes without allowing two active seasons', () => fresh(async ({ shard }) => {
		await Promise.all([
			Season1.startRun(shard, '100', 'W3N3', 1),
			Season2.startRun(shard, '100', 'E3N3', 2),
		]);
		const current = await active(shard);
		const winner = current.namespace === 'speedrun' ? Season1 : Season2;
		const loser = winner === Season1 ? Season2 : Season1;
		assert.strictEqual(await shard.data.zCard(winner.racingKey), 1);
		await emptyQueue(shard, loser);
		assert.strictEqual(await isCurrentSeasonRun(shard, current.namespace, '100',
			await shard.db.data.hGetAll(winner.runKey('100'))), true);
	}));

	test('late peer stops cannot deactivate the newly started season', () => fresh(async ({ shard }) => {
		await Season1.startRun(shard, '100', 'W3N3', 1);
		await Season2.startRun(shard, '100', 'E3N3', 2);
		await Season1.stopRun(shard, '100', 2);
		assert.deepStrictEqual(await active(shard), {
			namespace: 'speedrun-season2', shard: shard.name, room: 'E3N3', run: '1', startedTick: '2', active: true,
		});
	}));

	for (const reverse of [ false, true ]) {
		test(`landing in a disabled season ${reverse ? 1 : 2} cancels the previous clock without starting a new one`, () => fresh(async ({ shard }) => {
			const settings = reverse ? config.speedrun! : config.speedrunSeason2!;
			const before = settings.raceBrackets;
			try {
				settings.raceBrackets = [];
				const from = reverse ? Season2 : Season1;
				const to = reverse ? Season1 : Season2;
				await from.startRun(shard, '100', reverse ? 'E3N3' : 'W3N3', 1);
				const world = await worldOf(shard);
				await processRoom(shard, world, reverse ? 'W3N3' : 'E3N3');
				await emptyQueue(shard, from);
				await emptyQueue(shard, to);
				assert.deepStrictEqual({ ...await shard.db.data.hGetAll(to.runKey('100')) }, {});
				assert.strictEqual((await active(shard)).active, false);
			} finally {
				if (before === undefined) {
					delete settings.raceBrackets;
				} else {
					settings.raceBrackets = before;
				}
			}
		}));
	}

	test('out-of-block direct starts cannot cancel an existing race', () => fresh(async ({ shard }) => {
		await Season1.startRun(shard, '100', 'W3N3', 1);
		const marker = await shard.db.data.get(activeRunKey('100'));
		assert.strictEqual(await Season2.startRun(shard, '100', 'W3N3', 2), undefined);
		assert.strictEqual(await Season1.startRun(shard, '100', 'E3N3', 2), undefined);
		assert.strictEqual(await shard.db.data.get(activeRunKey('100')), marker);
		assert.strictEqual(await shard.data.zCard(Season1.racingKey), 1);
	}));

	test('the season-1 live board drops a replayed entry whose player is now in season 2', () => fresh(async ({ shard }) => {
		await Season1.startRun(shard, '100', 'W3N3', 1);
		await Season2.startRun(shard, '100', 'E3N3', 2);
		await shard.db.data.hDel(Season1.runKey('100'), [ 'endedTick' ]);
		await shard.data.zAdd(Season1.racingKey, [ [ 1, '100:1' ] ]);
		assert.deepStrictEqual(await Season1.readRacing(shard, 3), []);
		assert.strictEqual(await shard.data.zCard(Season1.racingKey), 0);
	}));

	test('a successful landing outside both blocks ends both clocks without opening either season', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		await Season2.startRun(shard, '100', 'E3N3', 0);
		const room = await shard.loadRoom('W12N1');
		runOneShot(world, room, shard.time, '', () => {
			room['#insertObject'](createRoomObject(new StructureController(), new RoomPosition(33, 32, room.name)));
		});
		room['#flushObjects'](null);
		room['#user'] = null;
		room['#level'] = 0;
		await shard.saveRoom(room.name, shard.time, room);
		assert.strictEqual((await processRoom(shard, world, room.name))['#user'], '100');
		await emptyQueue(shard, Season1);
		await emptyQueue(shard, Season2);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(Season1.runKey('100'))), []);
		assert.strictEqual((await active(shard)).active, false);
	}));

	test('scoring consumes due entries but does not automatically respawn at expiry', () => fresh(async ({ shard }) => {
		const world = await worldOf(shard);
		await processRoom(shard, world, 'E3N3');
		const before = await shard.db.data.hGetAll(Season2.runKey('100'));
		await runShardTickProcessors(shard, 50000);
		assert.deepStrictEqual(await shard.db.data.hGetAll(Season2.runKey('100')), before);
		assert.strictEqual(await shard.data.zCard(Season2.dueRunsKey), 0);
		assert.strictEqual(await shard.data.zCard(Season2.racingKey), 1);
		assert.deepStrictEqual(Object.keys(await shard.db.data.hGetAll(keys2.scoreKey(20000, '100:1'))), []);
		assert.deepStrictEqual(await acquireIntentsForRoom(shard, 'E3N3'), []);
	}));

	test('season 2 uses only its own live configuration for queue offsets', () => fresh(async ({ shard }) => {
		const before = config.speedrunSeason2!.raceBrackets;
		try {
			config.speedrunSeason2!.raceBrackets = [ 20, 40 ];
			await Season2.startRun(shard, '100', 'E3N3', 10);
			assert.deepStrictEqual(await shard.data.zRangeWithScores(Season2.dueRunsKey, 0, -1),
				[ [ 30, '100:1:20' ], [ 50, '100:1:40' ] ]);
			assert.deepStrictEqual(config.speedrun!.raceBrackets, [ 20000, 40000 ]);
		} finally {
			if (before === undefined) {
				delete config.speedrunSeason2!.raceBrackets;
			} else {
				config.speedrunSeason2!.raceBrackets = before;
			}
		}
	}));

	test('a real process restart retains run and queues without restarting or remapping', async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xs2-run-'));
		try {
			await fs.writeFile(path.join(directory, '.screepsrc.yaml'), JSON.stringify({
				mods: [ 'xxscreeps/mods/classic', 'xxscreeps/mods/speedrun-season2' ],
				runner: { sandbox: 'unsafe' },
			}));
			const run = async (source: string) => (await command(process.execPath,
				[ '--experimental-vm-modules', binary, 'eval', '-e', source ],
				{ cwd: directory, timeout: 8000, maxBuffer: 1024 * 1024 })).stdout;
			await run(`(async () => {
				const {readFile}=await import('node:fs/promises');
				const {Database,Shard}=await import('xxscreeps/engine/db/index.js');
				const {config}=await import('xxscreeps/config/index.js');
				const {importPayload,seedShard}=await import('xxscreeps/scripts/payload.js');
				const {initializeSeason2Map}=await import('xxscreeps/mods/speedrun-season2/map.js');
				const {RoomProcessor}=await import('xxscreeps/engine/processor/room.js');
				const {initializeIntentConstraints}=await import('xxscreeps/engine/processor/index.js');
				const {initializeGameEnvironment}=await import('xxscreeps/game/index.js');
				await import('xxscreeps:mods/processor');
				initializeGameEnvironment();initializeIntentConstraints();
				await using db=await Database.connect();
				await using shard=await Shard.connect(db,config.shards[0].name);
				await seedShard(shard,importPayload(JSON.parse(await readFile(${JSON.stringify(fixture)},'utf8'))));
				await initializeSeason2Map(shard,{serverStopped:true});
				const world=await shard.loadWorld(),room=await shard.loadRoom('E3N3');
				const terrain=world.terrain.get('E3N3').terrain;
				let tile;
				for(let y=2;y<48&&!tile;y++)for(let x=2;x<48;x++){
					if(!(terrain.get(x,y)&1)&&!room['#objects'].some(o=>o.pos.x===x&&o.pos.y===y)){tile=[x,y];break}
				}
				const processor=new RoomProcessor(shard,world,room,shard.time);
				processor.saveIntents('100',{local:{placeSpawn:[[...tile,'Spawn1']]},object:{},internal:true});
				await processor.process();await processor.finalize(false);
				await shard.data.set('time',1);
				await shard.save();await db.save();
				return 'landed in temporary fixture';
			})()`);
			const stdout = await run(`(async () => {
				const {Database,Shard}=await import('xxscreeps/engine/db/index.js');
				const {config}=await import('xxscreeps/config/index.js');
				const {runShardInitializers}=await import('xxscreeps/engine/processor/shard.js');
				const {isCurrentSeasonRun,activeRunKey}=await import('xxscreeps/mods/speedrun/race-lifecycle.js');
				await import('xxscreeps:mods/main');
				await using db=await Database.connect();
				await using shard=await Shard.connect(db,config.shards[0].name);
				await runShardInitializers(shard);
				const info=await db.data.hGetAll('speedrun-season2/run/100');
				await shard.save();await db.save();
				return JSON.stringify({
					info, marker:JSON.parse(await db.data.req(activeRunKey('100'))),
					due:await shard.data.zRangeWithScores('speedrun-season2/due',0,-1),
					racing:await shard.data.zRangeWithScores('speedrun-season2/racing',0,-1),
					valid:await isCurrentSeasonRun(shard,'speedrun-season2','100',info),
					old:await db.data.hGetAll('speedrun/run/100'),
					owner:(await shard.loadRoom('E3N3'))['#user'],
				});
			})()`);
			const read = JSON.parse(stdout.trim().split('\n').at(-1)!) as {
				info: Record<string, string>; due: [ number, string ][]; racing: [ number, string ][];
				marker: { active: boolean }; valid: boolean; old: Record<string, string>; owner: string;
			};
			assert.deepStrictEqual(read.info, { run: '1', room: 'E3N3', startedTick: '1' });
			assert.deepStrictEqual(read.due, [ [ 20001, '100:1:20000' ], [ 40001, '100:1:40000' ] ]);
			assert.deepStrictEqual(read.racing, [ [ 1, '100:1' ] ]);
			assert.strictEqual(read.marker.active, true);
			assert.strictEqual(read.valid, true);
			assert.deepStrictEqual(read.old, {});
			assert.strictEqual(read.owner, '100');
		} finally {
			await fs.rm(directory, { recursive: true, force: true });
		}
	});
});
