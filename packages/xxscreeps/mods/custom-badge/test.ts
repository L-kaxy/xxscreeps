import type { CustomBadgeSettings } from './config.js';
import type { Drawing } from './drawing.js';
import { makeToken } from 'xxscreeps/backend/auth/token.js';
import { config } from 'xxscreeps/config/index.js';
import { Database } from 'xxscreeps/engine/db/index.js';
import * as Badge from 'xxscreeps/engine/db/user/badge.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { setPassword } from 'xxscreeps/mods/backend/password/model.js';
import { catalog } from 'xxscreeps/mods/meta/decorations/catalog.js';
import { activateBadge, grant } from 'xxscreeps/mods/meta/decorations/model.js';
import { instantiateTestShard } from 'xxscreeps/test/import.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { DrawingError, compileDrawing, newDrawing, parseDrawing, polygonFromCanvas, shapePath } from './drawing.js';
import { BadgeError, defaultBadge, moderate, readSelf, resetSelf, saveDrawing, saveLegacyBadge, stateKey } from './model.js';
import { startBadgeTestServer } from './test-http.js';

function withSettings(patch: CustomBadgeSettings = {}) {
	const previous = config.customBadge;
	config.customBadge = { enabled: true, saveCooldownSeconds: 0, adminUsers: [ '101' ], ...patch };
	return { [Symbol.dispose]() { if (previous === undefined) { delete config.customBadge; } else { config.customBadge = previous; } } };
}

const rejects = (operation: Promise<unknown>, status: number) =>
	assert.rejects(operation, (error: unknown) => error instanceof BadgeError && error.status === status);

const polygonDrawing = (): Drawing => {
	const drawing = newDrawing();
	drawing.shapes = [ {
		...drawing.shapes[0]!, kind: 'polygon',
		points: [ { x: -50, y: -50 }, { x: 50, y: -50 }, { x: 10, y: 10 }, { x: -50, y: 50 } ],
	} ];
	return drawing;
};

describe('custom-badge', () => {
	describe('geometry', () => {
		test('canonical compiler is deterministic and emits only finite path commands', () => {
			const first = compileDrawing(newDrawing());
			assert.deepStrictEqual(compileDrawing(first.drawing), first);
			assert.match(first.badge.type.path1, /^M [-\d. L]+ Z$/);
			assert.match(first.badge.type.path2, /^M [-\d. ]+ C [-\d. ]+ Z$/);
			assert.strictEqual(first.badge.flip, false);
		});
		test('all four primitives compile after rotation, scale and reflection', () => {
			for (const kind of [ 'circle', 'rectangle', 'triangle', 'polygon' ] as const) {
				const drawing = polygonDrawing();
				const shape = drawing.shapes[0]!;
				shape.kind = kind; shape.rotation = 73; shape.mirrorX = true; shape.mirrorY = true;
				if (kind !== 'polygon') { delete shape.points; }
				assert.match(compileDrawing(drawing).badge.type.path1, /^[MLCZ\d. -]+$/);
			}
		});
		test('mirrored polygons retain positive winding and do not punch same-layer holes', () => {
			for (const mirrorX of [ false, true ]) {
				for (const mirrorY of [ false, true ]) {
					const shape = { ...polygonDrawing().shapes[0]!, mirrorX, mirrorY };
					const values = shapePath(shape).match(/-?\d+(?:\.\d+)?/g)!.map(Number);
					let area = 0;
					for (let index = 0; index < values.length; index += 2) {
						const next = (index + 2) % values.length;
						area += values[index]! * values[next + 1]! - values[next]! * values[index + 1]!;
					}
					assert.ok(area > 0);
				}
			}
		});
		test('uppercase colors normalize; source objects are never mutated', () => {
			const drawing = newDrawing(); drawing.colors[0] = '#ABCDEF';
			drawing.shapes[0]!.x = 1.234567;
			const parsed = parseDrawing(drawing);
			assert.strictEqual(parsed.colors[0], '#abcdef');
			assert.strictEqual(parsed.shapes[0]!.x, 1.235);
			assert.strictEqual(drawing.colors[0], '#ABCDEF');
			assert.strictEqual(drawing.shapes[0]!.x, 1.234567);
		});
		test('empty drawings are allowed; layer order is independent of insertion order', () => {
			const drawing = newDrawing();
			const expected = compileDrawing(drawing);
			drawing.shapes.reverse();
			assert.deepStrictEqual(compileDrawing(drawing).badge, expected.badge);
			drawing.shapes = [];
			assert.deepStrictEqual(compileDrawing(drawing).badge.type, { path1: '', path2: '' });
		});
		const bad: [ string, (drawing: Drawing) => unknown ][] = [
			[ 'unknown document properties', drawing => ({ ...drawing, svg: '<script/>' }) ],
			[ 'unknown shape properties', drawing => { Object.assign(drawing.shapes[0]!, { path: '"/><script/>' }); return drawing; } ],
			[ 'HTML in a color', drawing => { drawing.colors[0] = '" onload="alert(1)'; return drawing; } ],
			[ 'trailing newlines in a color', drawing => { drawing.colors[0] = '#123456\n'; return drawing; } ],
			[ 'CSS colors and URLs', drawing => { drawing.colors[0] = 'url(https://example.invalid)'; return drawing; } ],
			[ 'string coordinates', drawing => { Object.assign(drawing.shapes[0]!, { x: '50' }); return drawing; } ],
			[ 'NaN coordinates', drawing => { drawing.shapes[0]!.x = NaN; return drawing; } ],
			[ 'infinite coordinates', drawing => { drawing.shapes[0]!.y = Infinity; return drawing; } ],
			[ 'out-of-range centers', drawing => { drawing.shapes[0]!.x = -1; return drawing; } ],
			[ 'unbounded dimensions', drawing => { drawing.shapes[0]!.height = 100000; return drawing; } ],
			[ 'zero dimensions', drawing => { drawing.shapes[0]!.width = 0; return drawing; } ],
			[ 'unbounded rotation', drawing => { drawing.shapes[0]!.rotation = 99999; return drawing; } ],
			[ 'non-boolean reflection', drawing => { Object.assign(drawing.shapes[0]!, { mirrorX: 1 }); return drawing; } ],
			[ 'unknown primitive', drawing => { Object.assign(drawing.shapes[0]!, { kind: 'svg' }); return drawing; } ],
			[ 'unknown layer', drawing => { Object.assign(drawing.shapes[0]!, { layer: 3 }); return drawing; } ],
			[ 'duplicate IDs', drawing => { drawing.shapes[1]!.id = drawing.shapes[0]!.id; return drawing; } ],
			[ 'markup IDs', drawing => { drawing.shapes[0]!.id = '<img>'; return drawing; } ],
			[ 'too many objects', drawing => { drawing.shapes = Array.from({ length: 33 }, (_value, ii) => ({ ...drawing.shapes[0]!, id: `s${ii}` })); return drawing; } ],
			[ 'unexpected vertices', drawing => { drawing.shapes[0]!.points = []; return drawing; } ],
			[ 'unsupported schema', drawing => ({ ...drawing, schemaVersion: 2 }) ],
		];
		for (const [ name, mutation ] of bad) {
			test(`rejects ${name}`, () => { assert.throws(() => compileDrawing(mutation(newDrawing())), DrawingError); });
		}
		for (const [ name, points ] of [
			[ 'too few', [ { x: 0, y: 0 } ] ],
			[ 'too many', Array.from({ length: 17 }, (_value, ii) => ({ x: ii, y: ii % 2 })) ],
			[ 'collinear', [ { x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 20 } ] ],
			[ 'self intersecting', [ { x: -40, y: -40 }, { x: 40, y: 40 }, { x: -40, y: 40 }, { x: 30, y: -40 } ] ],
			[ 'out of bounds', [ { x: -99, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 40 } ] ],
			[ 'duplicate adjacent', [ { x: -40, y: -40 }, { x: 40, y: -40 }, { x: 40, y: -40 }, { x: 0, y: 40 } ] ],
		] as [ string, { x: number; y: number }[] ][]) {
			test(`rejects ${name} polygon points`, () => {
				const drawing = polygonDrawing(); drawing.shapes[0]!.points = points;
				assert.throws(() => compileDrawing(drawing), DrawingError);
			});
		}
		test('combined path budget is enforced before publication', () => {
			assert.throws(() => compileDrawing(newDrawing(), { maxShapes: 32, maxPathLength: 1 }), DrawingError);
		});
		test('fractional canvas coordinates do not escape local polygon bounds through rounding', () => {
			for (let step = 1; step < 100; ++step) {
				const left = 12.437 + step / 171;
				const right = 83.731 - step / 179;
				const top = 11.187 + step / 177;
				const bottom = 93.151 - step / 183;
				const shape = polygonFromCanvas([ { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom } ], 'canvas', 1);
				assert.doesNotThrow(() => compileDrawing({ ...newDrawing(), shapes: [ shape ] }));
			}
		});
		test('canvas polygons reject flat shapes and out-of-canvas points before normalization', () => {
			assert.throws(() => polygonFromCanvas([ { x: 10, y: 10 }, { x: 11, y: 10 }, { x: 12, y: 10 } ], 'flat', 1), DrawingError);
			assert.throws(() => polygonFromCanvas([ { x: -1, y: 0 }, { x: 11, y: 10 }, { x: 12, y: 20 } ], 'outside', 1), DrawingError);
		});
	});

	describe('account persistence and concurrency', () => {
		test('draft is private and does not grant or change the equipped badge', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await Badge.save(fixture.db, '100', JSON.stringify(defaultBadge));
			await saveDrawing(fixture.db, '100', 0, newDrawing(), false);
			const state = await readSelf(fixture.db, '100');
			assert.strictEqual(state.version, 1); assert.strictEqual(state.published, null);
			assert.deepStrictEqual(state.badge, defaultBadge);
			await assert.rejects(Badge.validate(fixture.db, '100', compileDrawing(newDrawing()).badge), /not granted/);
			assert.strictEqual((await readSelf(fixture.db, '101')).draft, null);
		});
		test('publish atomically stores source, grant and the normal account badge', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			const compiled = compileDrawing(newDrawing());
			await saveDrawing(fixture.db, '100', 0, compiled.drawing, true);
			const state = await readSelf(fixture.db, '100');
			assert.deepStrictEqual(state.draft, compiled.drawing); assert.deepStrictEqual(state.badge, compiled.badge);
			assert.deepStrictEqual(await Badge.validate(fixture.db, '100', compiled.badge), compiled.badge);
			await assert.rejects(Badge.validate(fixture.db, '101', compiled.badge), /not granted/);
		});
		test('later drafts preserve the published symbol and applied colors', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			const drawing = newDrawing(); drawing.shapes[0]!.x = 33; drawing.colors[0] = '#123456';
			await saveDrawing(fixture.db, '100', 1, drawing, false);
			const current = await readSelf(fixture.db, '100');
			assert.deepStrictEqual(current.badge, compileDrawing(newDrawing()).badge);
			assert.deepStrictEqual(current.draft, drawing);
		});
		test('a replaced symbol is no longer wearable', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			const drawing = newDrawing(); drawing.shapes[0]!.x = 25;
			await saveDrawing(fixture.db, '100', 1, drawing, true);
			await assert.rejects(Badge.validate(fixture.db, '100', compileDrawing(newDrawing()).badge), /not granted/);
		});
		test('stale tabs cannot change the source, grant or current badge', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			const before = await readSelf(fixture.db, '100');
			await rejects(saveDrawing(fixture.db, '100', 0, newDrawing(), true), 409);
			assert.deepStrictEqual(await readSelf(fixture.db, '100'), before);
		});
		test('two parallel saves admit exactly one version', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			const results = await Promise.allSettled([
				saveDrawing(fixture.db, '100', 0, newDrawing(), true),
				saveDrawing(fixture.db, '100', 0, polygonDrawing(), true),
			]);
			assert.strictEqual(results.filter(result => result.status === 'fulfilled').length, 1);
			assert.strictEqual((await readSelf(fixture.db, '100')).version, 1);
		});
		test('an in-flight legacy save cannot restore a symbol after an admin block', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			const previous = fixture.db.data.eval.bind(fixture.db.data);
			fixture.db.data.eval = async (script, keys, args) => {
				fixture.db.data.eval = previous;
				await moderate(fixture.db, '101', '100', 1, 'block');
				return previous(script, keys, args);
			};
			try {
				await rejects(saveLegacyBadge(fixture.db, '100', compileDrawing(newDrawing()).badge), 409);
			} finally { fixture.db.data.eval = previous; }
			const state = await readSelf(fixture.db, '100');
			assert.strictEqual(state.blocked, true); assert.strictEqual(state.version, 2);
			assert.deepStrictEqual(state.badge, defaultBadge);
		});
		test('a concurrent original Badge.save is detected even without a mod revision change', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			const previous = fixture.db.data.eval.bind(fixture.db.data);
			fixture.db.data.eval = async (script, keys, args) => {
				fixture.db.data.eval = previous;
				await Badge.save(fixture.db, '100', JSON.stringify(defaultBadge));
				return previous(script, keys, args);
			};
			try { await rejects(saveDrawing(fixture.db, '100', 0, newDrawing(), true), 409); } finally { fixture.db.data.eval = previous; }
			assert.strictEqual((await readSelf(fixture.db, '100')).version, 0);
			assert.deepStrictEqual((await readSelf(fixture.db, '100')).badge, defaultBadge);
		});
		test('a storage failure before commit leaves neither grant nor partial account badge', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			const previous = fixture.db.data.eval.bind(fixture.db.data);
			fixture.db.data.eval = () => Promise.reject(new Error('injected storage failure'));
			try { await assert.rejects(saveDrawing(fixture.db, '100', 0, newDrawing(), true), /injected/); } finally { fixture.db.data.eval = previous; }
			assert.strictEqual((await readSelf(fixture.db, '100')).version, 0);
			assert.strictEqual((await readSelf(fixture.db, '100')).badge, null);
			await assert.rejects(Badge.validate(fixture.db, '100', compileDrawing(newDrawing()).badge), /not granted/);
		});
		test('cooldown is persisted and rejected submissions do not advance version', async () => {
			using options = withSettings({ saveCooldownSeconds: 10 }); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), false, 1000);
			await rejects(saveDrawing(fixture.db, '100', 1, newDrawing(), true, 10999), 429);
			assert.strictEqual((await readSelf(fixture.db, '100')).version, 1);
			await saveDrawing(fixture.db, '100', 1, newDrawing(), true, 11000);
		});
		test('invalid drawings change nothing, including grants', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await assert.rejects(saveDrawing(fixture.db, '100', 0, { svg: '<script/>' }, true), DrawingError);
			assert.strictEqual(await fixture.db.data.get(stateKey('100')), null);
			assert.strictEqual((await readSelf(fixture.db, '100')).badge, null);
		});
		test('ordinary builtin badge saves remain available and invalidate stale editor versions', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			for (const type of [ 1, 24 ]) { await saveLegacyBadge(fixture.db, '100', { ...defaultBadge, type, _watching: true }); }
			assert.deepStrictEqual((await readSelf(fixture.db, '100')).badge, { ...defaultBadge, type: 24 });
			await rejects(saveDrawing(fixture.db, '100', 0, newDrawing(), true), 409);
			await rejects(saveLegacyBadge(fixture.db, '100', { ...defaultBadge, type: 1.5 }), 400);
		});
		test('decoration-granted symbols still work through the guarded legacy save', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			const item = await grant(fixture.db, '100', 'xx-chevrons');
			await activateBadge(fixture.db, '100', item, {});
			const badge = { ...defaultBadge, type: catalog.definitions.get('xx-chevrons')!.badge! };
			await saveLegacyBadge(fixture.db, '100', badge);
			assert.deepStrictEqual((await readSelf(fixture.db, '100')).badge, {
				color1: badge.color1, color2: badge.color2, color3: badge.color3, flip: false, type: badge.type,
			});
		});
		test('self reset retains drafts but removes grant and actually changes current badge', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			await resetSelf(fixture.db, '100', 1);
			const state = await readSelf(fixture.db, '100');
			assert.deepStrictEqual(state.badge, defaultBadge); assert.deepStrictEqual(state.draft, newDrawing());
			assert.strictEqual(state.published, null);
			await rejects(saveLegacyBadge(fixture.db, '100', compileDrawing(newDrawing()).badge), 400);
		});
		test('blocking resets worn badge, clears source and grant, and cannot be undone by old API', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			await moderate(fixture.db, '101', '100', 1, 'block');
			const state = await readSelf(fixture.db, '100');
			assert.strictEqual(state.blocked, true); assert.strictEqual(state.draft, null); assert.strictEqual(state.published, null);
			assert.deepStrictEqual(state.badge, defaultBadge);
			await rejects(saveDrawing(fixture.db, '100', 2, newDrawing(), true), 403);
			await rejects(saveLegacyBadge(fixture.db, '100', compileDrawing(newDrawing()).badge), 400);
			await saveLegacyBadge(fixture.db, '100', { ...defaultBadge, type: 2 });
		});
		test('unblocking does not resurrect a revoked design', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			await moderate(fixture.db, '101', '100', 1, 'block');
			await moderate(fixture.db, '101', '100', 2, 'unblock');
			const state = await readSelf(fixture.db, '100');
			assert.strictEqual(state.blocked, false); assert.strictEqual(state.draft, null); assert.strictEqual(state.published, null);
			await saveDrawing(fixture.db, '100', 3, newDrawing(), true);
		});
		test('ordinary players cannot moderate anyone including themselves', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await rejects(moderate(fixture.db, '100', '100', 0, 'unblock'), 403);
			await rejects(moderate(fixture.db, '100', '101', 0, 'block'), 403);
		});
		test('disabling new saves preserves the existing badge and permits builtin fallback', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			using disabled = withSettings({ enabled: false });
			await rejects(saveDrawing(fixture.db, '100', 1, newDrawing(), true), 403);
			assert.deepStrictEqual((await readSelf(fixture.db, '100')).badge, compileDrawing(newDrawing()).badge);
			await saveLegacyBadge(fixture.db, '100', defaultBadge);
		});
		test('lowering limits rejects publication but does not lose the old source', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			using lower = withSettings({ maxShapes: 1 });
			assert.deepStrictEqual((await readSelf(fixture.db, '100')).draft, newDrawing());
			await assert.rejects(saveDrawing(fixture.db, '100', 1, newDrawing(), true), DrawingError);
		});
		test('state is account-scoped, readable on another database connection', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			await using other = await Database.connect({ data: 'local://data', pubsub: 'local://pubsub' });
			assert.deepStrictEqual(await readSelf(other, '100'), await readSelf(fixture.db, '100'));
		});
		test('only badge and mod data change, not account code, room relationships or season scores', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await fixture.db.data.hSet(User.infoKey('100'), 'gcl', '12345');
			await fixture.shard.data.set('speedrun-season2/test-marker', 'intact');
			const before = await fixture.db.data.hGetAll(User.infoKey('100'));
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			const { badge: _badge, ...after } = await fixture.db.data.hGetAll(User.infoKey('100'));
			assert.deepStrictEqual(after, { ...before });
			assert.strictEqual(await fixture.shard.data.get('speedrun-season2/test-marker'), 'intact');
		});
		test('user lifecycle hook removes the private mod record', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			await saveDrawing(fixture.db, '100', 0, newDrawing(), true);
			await User.remove(fixture.db, '100');
			assert.strictEqual(await fixture.db.data.get(stateKey('100')), null);
			await rejects(saveDrawing(fixture.db, '100', 0, newDrawing(), true), 404);
		});
		test('invalid IDs and NPC accounts are never writable', async () => {
			using options = withSettings(); await using fixture = await instantiateTestShard();
			for (const id of [ '2', '../100', '', 'guest', 'a'.repeat(65) ]) {
				await rejects(saveDrawing(fixture.db, id, 0, newDrawing(), true), 400);
			}
		});
	});

	describe('real HTTP', () => {
		async function fixture() {
			const instance = await instantiateTestShard();
			const server = await startBadgeTestServer(instance.shard);
			const token = await makeToken('100');
			const admin = await makeToken('101');
			return {
				...instance, ...server,
				async request(path: string, payload?: unknown, authorization: string | null = token) {
					return fetch(server.origin + path, {
						method: payload === undefined ? 'GET' : 'POST',
						headers: { ...authorization === null ? {} : { 'X-Token': authorization }, ...payload === undefined ? {} : { 'Content-Type': 'application/json' } },
						...payload === undefined ? {} : { body: JSON.stringify(payload) },
					});
				},
				token, admin,
				async [Symbol.asyncDispose]() { await server[Symbol.asyncDispose](); await instance[Symbol.asyncDispose](); },
			};
		}
		const publish = (version = 0) => ({ version, drawing: newDrawing(), publish: true });

		test('guest, missing and invalid tokens cannot read drafts or save', async () => {
			using options = withSettings(); await using http = await fixture();
			for (const token of [ null, 'guest', 'invalid' ]) {
				assert.strictEqual((await http.request('/api/custom-badge/me', undefined, token)).status, 401);
				assert.strictEqual((await http.request('/api/custom-badge/save', publish(), token)).status, 401);
			}
		});
		test('publish goes through real auth and appears in the original SVG endpoint', async () => {
			using options = withSettings(); await using http = await fixture();
			const response = await http.request('/api/custom-badge/save', publish());
			assert.strictEqual(response.status, 200); assert.notStrictEqual(response.headers.get('X-Token'), null);
			assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');
			const svg = await http.request('/api/user/badge-svg?username=Player%201&border=1', undefined, null);
			assert.match(svg.headers.get('Content-Type')!, /image\/svg\+xml/);
			const text = await svg.text();
			assert.ok(text.includes(compileDrawing(newDrawing()).badge.type.path1));
			assert.match(text, /stroke-width="5"/);
			assert.ok(!text.includes('<script'));
		});
		test('a userId in the body is rejected, not used to choose an account', async () => {
			using options = withSettings(); await using http = await fixture();
			assert.strictEqual((await http.request('/api/custom-badge/save', { ...publish(), userId: '101' })).status, 400);
			assert.strictEqual((await readSelf(http.db, '101')).draft, null);
		});
		test('string versions, unknown fields, direct path data and markup are rejected', async () => {
			using options = withSettings(); await using http = await fixture();
			for (const request of [ { ...publish(), version: '0' }, { ...publish(), svg: '<svg/>' },
				{ ...publish(), drawing: { type: { path1: '"/><script/>', path2: '' } } } ]) {
				assert.strictEqual((await http.request('/api/custom-badge/save', request)).status, 400);
			}
		});
		test('oversized payloads and non-JSON form submissions cannot save', async () => {
			using options = withSettings(); await using http = await fixture();
			const oversized = { ...publish(), drawing: { ...newDrawing(), colors: [ '#123456', 'a'.repeat(65536), '#123456' ] } };
			assert.strictEqual((await http.request('/api/custom-badge/save', oversized)).status, 413);
			const response = await fetch(http.origin + '/api/custom-badge/save', { method: 'POST', headers: { 'X-Token': http.token }, body: 'version=0' });
			assert.strictEqual(response.status, 415);
		});
		test('conflicting tabs get 409 without silently overwriting a badge', async () => {
			using options = withSettings(); await using http = await fixture();
			assert.strictEqual((await http.request('/api/custom-badge/save', publish())).status, 200);
			assert.strictEqual((await http.request('/api/custom-badge/save', publish())).status, 409);
		});
		test('cooldown returns 429 and Retry-After', async () => {
			using options = withSettings({ saveCooldownSeconds: 30 }); await using http = await fixture();
			await http.request('/api/custom-badge/save', publish());
			const response = await http.request('/api/custom-badge/save', publish(1));
			assert.strictEqual(response.status, 429); assert.ok(Number(response.headers.get('Retry-After')) > 0);
		});
		test('admin endpoints enforce roles and stale moderation versions', async () => {
			using options = withSettings(); await using http = await fixture();
			assert.strictEqual((await http.request('/api/custom-badge/admin/user?userId=101')).status, 403);
			assert.strictEqual((await http.request('/api/custom-badge/admin/moderate', { userId: '101', version: 0, action: 'block' })).status, 403);
			await http.request('/api/custom-badge/save', publish());
			assert.strictEqual((await http.request('/api/custom-badge/admin/moderate', { userId: '100', version: 0, action: 'block' }, http.admin)).status, 409);
			assert.strictEqual((await http.request('/api/custom-badge/admin/moderate', { userId: '100', version: 1, action: 'block' }, http.admin)).status, 200);
			assert.strictEqual((await http.request('/api/custom-badge/save', publish(2))).status, 403);
		});
		test('legacy route accepts builtin and own grant, rejects foreign or revoked paths', async () => {
			using options = withSettings(); await using http = await fixture();
			await http.request('/api/custom-badge/save', publish());
			const body = { badge: { ...compileDrawing(newDrawing()).badge, color1: '#654321' } };
			assert.strictEqual((await http.request('/api/user/badge', body)).status, 200);
			assert.strictEqual((await http.request('/api/user/badge', body, http.admin)).status, 400);
			await http.request('/api/custom-badge/admin/moderate', { userId: '100', version: 2, action: 'block' }, http.admin);
			assert.strictEqual((await http.request('/api/user/badge', body)).status, 400);
			assert.strictEqual((await http.request('/api/user/badge', { badge: defaultBadge })).status, 200);
		});
		test('page and both actual compiled modules are served with restrictive headers', async () => {
			using options = withSettings(); await using http = await fixture();
			const redirect = await http.request('/custom-badge', undefined, null);
			assert.strictEqual(redirect.status, 200); assert.strictEqual(redirect.url, http.origin + '/custom-badge/');
			const page = await http.request('/custom-badge/', undefined, null);
			assert.strictEqual(page.status, 200);
			assert.match(page.headers.get('Content-Security-Policy')!, /frame-ancestors 'none'/);
			assert.match(await page.text(), /src="assets\/editor.js"/);
			for (const name of [ 'editor', 'drawing' ]) {
				const script = await http.request(`/custom-badge/assets/${name}.js`, undefined, null);
				assert.strictEqual(script.status, 200); assert.match(script.headers.get('Content-Type')!, /javascript/);
				assert.ok((await script.text()).length > 1000);
			}
			assert.strictEqual((await http.request('/custom-badge/assets/model.js', undefined, null)).status, 404);
		});
		test('menu is opt-in and does not expose administrator IDs', async () => {
			using options = withSettings(); await using http = await fixture();
			const publicConfig = await (await http.request('/api/custom-badge/config', undefined, null)).text();
			assert.ok(!publicConfig.includes('adminUsers'));
			assert.match(await (await http.request('/api/version', undefined, null)).text(), /Badge Studio/);
			using disabled = withSettings({ enabled: false });
			assert.ok(!(await (await http.request('/api/version', undefined, null)).text()).includes('Badge Studio'));
		});
		test('real password authentication can obtain and refresh an editing token', async () => {
			using options = withSettings(); await using http = await fixture();
			await setPassword(http.db, '100', 'badge-test-password');
			const response = await http.request('/api/auth/signin', { email: 'Player 1', password: 'badge-test-password' }, null);
			assert.strictEqual(response.status, 200);
			const payload = await response.json() as { token: string };
			const me = await http.request('/api/custom-badge/me', undefined, payload.token);
			assert.strictEqual(me.status, 200); assert.notStrictEqual(me.headers.get('X-Token'), null);
			assert.strictEqual((await http.request('/api/auth/signin', { email: 'Player 1', password: 'wrong' }, null)).status, 401);
		});
	});
});
