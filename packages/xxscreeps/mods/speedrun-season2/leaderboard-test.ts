import type { LeaderboardEntry, PlayerRecord, RacingEntry } from 'xxscreeps/mods/speedrun/race-core.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import * as Season1 from 'xxscreeps/mods/speedrun/race.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import { initializeSeason2Map } from './map.js';
import { season2Page } from './page.js';
import * as Race from './race.js';
import { scoreable, shortSeason } from './test-fixture.js';
import { startBoardServer } from './test-http.js';

interface Board {
	ok: number;
	bracket?: number;
	brackets: number[];
	count: number;
	list: LeaderboardEntry[];
	users: Record<string, { _id: string; username: string; badge: unknown }>;
}
interface Records {
	ok: number;
	user: string;
	username: string | null;
	brackets: { bracket: number; score: number }[];
	list: PlayerRecord[];
}
interface Live {
	ok: number;
	time: number;
	tickSpeed: number;
	list: RacingEntry[];
	users: Board['users'];
}
const fresh = simulate({});
const get = async <Type>(origin: string, route: string): Promise<Type> => {
	const response = await fetch(origin + route);
	assert.strictEqual(response.status, 200);
	return await response.json() as Type;
};
const base = '/api/speedrun-season2';

describe('season-2 leaderboard HTTP', () => {
	test('three empty public endpoints are independent of legacy result tables', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await shard.db.data.zAdd(Season1.bestKey(2), [ [ 999, '100' ] ]);
		await using server = await startBoardServer(shard);
		const board = await get<Board>(server.origin, `${base}/leaderboard`);
		assert.deepStrictEqual(board, { ok: 1, bracket: 2, brackets: [ 2, 4 ], count: 0, list: [], users: {} });
		const records = await get<Records>(server.origin, `${base}/records/100`);
		assert.deepStrictEqual(records.list, []);
		assert.deepStrictEqual(records.brackets, []);
		const live = await get<Live>(server.origin, `${base}/racing`);
		assert.deepStrictEqual(live.list, []);
		assert.strictEqual(await shard.db.data.zCard(Season1.bestKey(2)), 1);
	}));

	test('real HTTP pagination uses best-per-player results and ranks from zero', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await initializeSeason2Map(shard, { serverStopped: true });
		const world = await shard.loadWorld();
		for (const [ user, progress ] of [ [ '100', 100 ], [ '101', 300 ], [ '102', 200 ] ] as const) {
			await scoreable(shard, world, 'E3N3', user, progress);
			await Race.startRun(shard, user, 'E3N3', 0);
			await Race.captureBracket(shard, `${user}:1:2`, 2);
			await Race.stopRun(shard, user, 3);
		}
		await using server = await startBoardServer(shard);
		const board = await get<Board>(server.origin, `${base}/leaderboard?bracket=2&offset=1&limit=1`);
		assert.strictEqual(board.count, 3);
		assert.deepStrictEqual(board.list.map(entry => [ entry.user, entry.rank, entry.score ]), [ [ '102', 1, 45400 ] ]);
		assert.strictEqual(board.users['102']?._id, '102');
		assert.strictEqual(board.list[0]?.record?.room, 'E3N3');
		assert.deepStrictEqual((await get<Board>(server.origin, `${base}/leaderboard?offset=99`)).list, []);
		assert.strictEqual((await get<Board>(server.origin, '/api/speedrun/leaderboard?bracket=2')).count, 0);
	}));

	test('history keeps every run and bracket, including brackets no longer configured', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await initializeSeason2Map(shard, { serverStopped: true });
		const world = await shard.loadWorld();
		await scoreable(shard, world);
		await Race.startRun(shard, '100', 'E3N3', 0);
		await Race.captureBracket(shard, '100:1:2', 2);
		await Race.captureBracket(shard, '100:1:4', 4);
		await scoreable(shard, world, 'E3N3', '100', 900);
		await Race.startRun(shard, '100', 'E3N3', 5);
		await Race.captureBracket(shard, '100:2:2', 7);
		await using server = await startBoardServer(shard);
		config.speedrunSeason2!.raceBrackets = [];
		const all = await get<Records>(server.origin, `${base}/records/100`);
		assert.strictEqual(all.list.length, 3);
		assert.deepStrictEqual(all.brackets.map(entry => entry.bracket).sort((left, right) => left - right), [ 2, 4 ]);
		assert.strictEqual((await get<Records>(server.origin, `${base}/records/100?bracket=4`)).list.length, 1);
		assert.strictEqual((await get<Board>(server.origin, `${base}/leaderboard?bracket=2`)).list[0]?.record?.run, 1);
		assert.deepStrictEqual(await get<Board>(server.origin, `${base}/leaderboard`),
			{ ok: 1, brackets: [], count: 0, list: [], users: {} });
	}));

	test('deleted and unknown users have safe empty/null or tombstone responses', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await initializeSeason2Map(shard, { serverStopped: true });
		await scoreable(shard, await shard.loadWorld());
		await Race.startRun(shard, '100', 'E3N3', 0);
		await Race.captureBracket(shard, '100:1:2', 2);
		await shard.db.data.vDel(User.infoKey('100'));
		await using server = await startBoardServer(shard);
		const board = await get<Board>(server.origin, `${base}/leaderboard`);
		assert.strictEqual(board.users['100']?.username, '[deleted]');
		const unknown = await get<Records>(server.origin, `${base}/records/unknown`);
		assert.strictEqual(unknown.username, null);
		assert.deepStrictEqual(unknown.list, []);
		assert.strictEqual((await get<Records>(server.origin, `${base}/records/100`)).list.length, 1);
	}));

	for (const query of [ 'offset=-1', 'offset=1.2', 'limit=0', 'limit=101', 'limit=x', 'bracket=x', 'bracket=1.2', 'limit=1&limit=2' ]) {
		test(`invalid query ${query} is refused by the real validator`, () => fresh(async ({ shard }) => {
			await using server = await startBoardServer(shard);
			assert.deepStrictEqual(await get(server.origin, `${base}/leaderboard?${query}`), { error: 'invalid' });
		}));
	}

	test('records validator and HTTP method guard reject invalid requests', () => fresh(async ({ shard }) => {
		await using server = await startBoardServer(shard);
		assert.deepStrictEqual(await get(server.origin, `${base}/records/100?bracket=bad`), { error: 'invalid' });
		assert.strictEqual((await fetch(`${server.origin}${base}/leaderboard`, { method: 'POST' })).status, 405);
	}));

	test('live endpoint reads the persisted tick, current RCL and only this season', () => fresh(async ({ shard }) => {
		using settings = shortSeason();
		await initializeSeason2Map(shard, { serverStopped: true });
		await scoreable(shard, await shard.loadWorld());
		await Race.startRun(shard, '100', 'E3N3', 0);
		await Season1.startRun(shard, '101', 'W3N3', 0);
		await using server = await startBoardServer(shard);
		const live = await get<Live>(server.origin, `${base}/racing`);
		assert.strictEqual(live.time, shard.time);
		assert.strictEqual(live.tickSpeed, config.game.tickSpeed);
		assert.deepStrictEqual(live.list.map(entry => [ entry.user, entry.room, entry.level ]), [ [ '100', 'E3N3', 3 ] ]);
		assert.deepStrictEqual(live.list[0]?.brackets.map(entry => entry.left), [ 2, 4 ]);
		await Race.stopRun(shard, '100', 1);
		assert.deepStrictEqual((await get<Live>(server.origin, `${base}/racing`)).list, []);
		assert.strictEqual((await get<Live>(server.origin, '/api/speedrun/racing')).list[0]?.user, '101');
	}));

	test('both page URLs, slash variants and independent official-client menu entries coexist', () => fresh(async ({ shard }) => {
		await using server = await startBoardServer(shard);
		for (const path of [ '/speedrun-season2', '/speedrun-season2/' ]) {
			const response = await fetch(server.origin + path);
			assert.match(response.headers.get('content-type')!, /text\/html/);
			assert.strictEqual(await response.text(), season2Page);
		}
		const old = await (await fetch(`${server.origin}/speedrun`)).text();
		assert.match(old, /<title>Speedrun —/);
		assert.ok(!old.includes('/api/speedrun-season2/'));
		assert.ok(season2Page.includes('/api/speedrun-season2/leaderboard'));
		assert.ok(!season2Page.includes('/api/speedrun/'));
		const version = await get<{ serverData: { features: { name: string; menuData?: { item: { href: string; id: string; target: string } }[] }[] } }>(server.origin, '/api/version');
		for (const name of [ 'speedrun', 'speedrun-season2' ]) {
			const entries = version.serverData.features.filter(entry => entry.name === name);
			assert.strictEqual(entries.length, 1);
			assert.deepStrictEqual(entries[0]?.menuData?.map(menu => [ menu.item.href, menu.item.id, menu.item.target ]),
				[ [ `/${name}`, `menu-item-${name}`, '_blank' ] ]);
		}
	}));
});
