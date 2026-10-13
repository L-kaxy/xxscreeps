import { runInNewContext } from 'node:vm';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { season2Page } from './page.js';

class Element {
	innerHTML = '';
	textContent = '';
	hidden = true;
	disabled = false;
	tables: Element[] = [];
	events = new Map<string, () => unknown>();
	addEventListener(event: string, callback: () => unknown) { this.events.set(event, callback); }
	querySelectorAll(selector: string) {
		if (selector === 'table') {
			this.tables = Array.from(this.innerHTML.matchAll(/<table>/g), () => new Element());
			return this.tables;
		}
		return [];
	}
}

interface PageContext {
	renderBoard: (table: Element, page: unknown) => void;
	renderBoards: (pages: unknown[]) => void;
	renderLive: (page: unknown) => void;
	renderDetail: (payload: unknown) => void;
	openDetail: (user: string) => void;
	closeDetail: () => void;
	loadBoard: () => Promise<void>;
	refresh: () => Promise<void>;
	state: { brackets: number[]; offset: number; limit: number; busy: boolean; user: string | null };
	fetch: (path: string) => Promise<{ ok: boolean; json: () => unknown }>;
}

async function boot(brackets = [ 2, 4 ], hash = '') {
	const nodes = new Map<string, Element>();
	const node = (id: string) => {
		let value = nodes.get(id);
		if (!value) { nodes.set(id, value = new Element()); }
		return value;
	};
	const requests: string[] = [];
	const events = new Map<string, () => unknown>();
	const timers: (() => void)[] = [];
	const context = {
		document: { getElementById: node, hidden: false, addEventListener() {} },
		window: { addEventListener(event: string, callback: () => unknown) { events.set(event, callback); } },
		history: { replaceState() {} },
		location: { pathname: '/speedrun-season2', hash },
		setInterval(callback: () => void) { timers.push(callback); },
		fetch(path: string) {
			requests.push(path);
			let payload: object;
			if (path.includes('/racing')) {
				payload = { time: 42, brackets, list: [], users: {}, tickSpeed: 250 };
			} else if (path.includes('/records/')) {
				payload = { user: '100', username: 'Player', brackets: [], list: [] };
			} else {
				payload = { bracket: Number(new URL(path, 'http://localhost').searchParams.get('bracket') ?? brackets[0]), brackets, count: 0, list: [], users: {} };
			}
			return Promise.resolve({ ok: true, json: () => payload });
		},
	};
	const source = /<script>([\s\S]*)<\/script>/.exec(season2Page)?.[1];
	assert.ok(source !== undefined && source !== '');
	await runInNewContext(source, context, { timeout: 1000 }) as unknown;
	return { page: context as unknown as PageContext, node, requests, timers, events };
}

describe('season-2 page script', () => {
	test('boot uses only the new three endpoint families and renders both brackets', async () => {
		const { requests, node, timers } = await boot();
		assert.deepStrictEqual(requests.sort(), [
			'/api/speedrun-season2/leaderboard?offset=0&limit=25',
			'/api/speedrun-season2/leaderboard?offset=0&limit=25&bracket=4',
			'/api/speedrun-season2/racing',
		].sort());
		assert.strictEqual(node('boards').tables.length, 2);
		assert.match(node('live').innerHTML, /Nobody is on the clock/);
		assert.strictEqual(node('tick').textContent, 'tick 42');
		assert.strictEqual(timers.length, 1);
	});

	test('empty configured brackets show a clear empty state with no pager', async () => {
		const { node } = await boot([]);
		assert.match(node('boards').innerHTML, /No brackets are configured/);
		assert.strictEqual(node('pager').innerHTML, '');
	});

	test('refresh queries each configured bracket once, not twice', async () => {
		const { requests, page } = await boot();
		requests.length = 0;
		await page.refresh();
		assert.strictEqual(requests.length, 3);
		assert.strictEqual(new Set(requests).size, 3);
	});

	test('different bracket counts keep a useful shared pager and empty rows', async () => {
		const { page, node } = await boot();
		page.renderBoards([ { bracket: 2, count: 0, list: [], users: {} }, { bracket: 4, count: 30, list: [], users: {} } ]);
		assert.match(node('pager').innerHTML, /1–25/);
		assert.ok(!node('pager').innerHTML.includes('id="pager-next" disabled'));
		page.state.offset = 25;
		page.renderBoards([ { bracket: 2, count: 0, list: [], users: {} }, { bracket: 4, count: 30, list: [], users: {} } ]);
		assert.match(node('pager').innerHTML, /26–30/);
		assert.match(node('pager').innerHTML, /id="pager-next" disabled/);
		assert.match(node('boards').tables[0]!.innerHTML, /Nobody has finished/);
		assert.match(node('boards').tables[1]!.innerHTML, /No players on this page/);
	});

	test('pagination keeps independent API URLs and the requested offset', async () => {
		const { page, requests } = await boot();
		requests.length = 0;
		page.state.offset = 25;
		await page.loadBoard();
		assert.strictEqual(requests.length, 2);
		assert.ok(requests.every(path => path.startsWith('/api/speedrun-season2/leaderboard?offset=25&limit=25')));
	});

	test('wire names and IDs are escaped in table HTML and detail uses textContent', async () => {
		const { page, node } = await boot();
		const malicious = '<img src=x onerror="alert(1)">';
		const table = new Element();
		page.renderBoard(table, { list: [ { user: malicious, rank: 0, score: 123, record: { room: 'E3N3', level: 3 } } ], users: {} });
		assert.ok(!table.innerHTML.includes('<img'));
		assert.match(table.innerHTML, /&lt;img/);
		page.renderDetail({ user: malicious, username: malicious, brackets: [], list: [] });
		assert.strictEqual(node('detail-name').textContent, malicious);
		assert.ok(!node('detail-body').innerHTML.includes('<img'));
	});

	test('network failure is visible and the refresh button recovers', async () => {
		const { page, node } = await boot();
		const fetch = page.fetch;
		page.fetch = () => Promise.reject(new Error('<unavailable>'));
		await page.refresh();
		assert.match(node('boards').innerHTML, /Could not load the board/);
		assert.match(node('boards').innerHTML, /&lt;unavailable&gt;/);
		assert.match(node('live').innerHTML, /Could not load the live board/);
		assert.strictEqual(node('refresh').disabled, false);
		assert.strictEqual(page.state.busy, false);
		page.fetch = fetch;
		await page.refresh();
		assert.ok(!node('boards').innerHTML.includes('Could not load'));
	});

	test('player links are URL encoded and malformed hashes do not break startup', async () => {
		const { requests } = await boot([ 2 ], '#player=alice%2Fbob%3Fx');
		assert.ok(requests.includes('/api/speedrun-season2/records/alice%2Fbob%3Fx'));
		const bad = await boot([ 2 ], '#player=%E0%A4%A');
		assert.strictEqual(bad.node('detail').hidden, true);
		assert.match(bad.node('boards').innerHTML, /Best after 2/);
	});

	test('closing details clears selection and hides dialog and scrim', async () => {
		const { page, node } = await boot();
		page.openDetail('100');
		assert.strictEqual(node('detail').hidden, false);
		page.closeDetail();
		assert.strictEqual(page.state.user, null);
		assert.strictEqual(node('detail').hidden, true);
		assert.strictEqual(node('scrim').hidden, true);
	});
});
