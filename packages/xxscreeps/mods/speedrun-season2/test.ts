import type { SpeedrunSeason2Settings } from './config.js';
import type { SpeedrunSettings } from 'xxscreeps/mods/speedrun/config.js';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Ajv } from 'ajv';
import { config, makeInitializationDefaults } from 'xxscreeps/config/index.js';
import { mods } from 'xxscreeps/config/mods.js';
import { initializationDefaults as season1Defaults } from 'xxscreeps/mods/speedrun/config.js';
import { isSpeedrunRoom } from 'xxscreeps/mods/speedrun/scope.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { initializationDefaults } from './config.js';
import schema from './config.schema.json' with { type: 'json' };
import { isSeason2Room, isSeason2SpawnRoom, season2SpawnRoom } from './rooms.js';
import { manifest } from './index.js';
import './map-test.js';
import './spawn-test.js';
import './invader-test.js';
import './global-rules-test.js';
import './lifecycle-test.js';
import './score-test.js';

const season1Mod = 'xxscreeps/mods/speedrun';
const season2Mod = 'xxscreeps/mods/speedrun-season2';
const expectedDefaults: SpeedrunSeason2Settings = {
	invaders: false,
	respawnCleanup: true,
	raceBrackets: [ 20000, 40000 ],
	respawnAfter: 40000,
};
const validate = new Ajv().compile(schema);
const run = promisify(execFile);
const binary = fileURLToPath(new URL('../../../xxscreeps.js', import.meta.url));

interface ConfigInspection {
	speedrun: SpeedrunSettings;
	speedrunSeason2?: SpeedrunSeason2Settings;
	seasonMods: { name: string; providers: string[] }[];
}

/** Exercise the real loader and YAML/default/schema pipeline in a fresh process, without a DB. */
async function inspectConfig(raw: object): Promise<ConfigInspection> {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'xxscreeps-season2-config-'));
	try {
		await fs.writeFile(path.join(directory, '.screepsrc.yaml'), JSON.stringify(raw));
		const source = `(async () => {
			const { config } = await import('xxscreeps/config/index.js');
			const { mods } = await import('xxscreeps/config/mods.js');
			return JSON.stringify({
				speedrun: config.speedrun,
				speedrunSeason2: config.speedrunSeason2,
				seasonMods: mods.filter(mod => /\\/speedrun(?:-season2)?\\/index\\.js$/.test(mod.url))
					.map(mod => ({ name: new URL(mod.url).pathname.split('/').at(-2), providers: Object.keys(mod.provides) })),
			});
		})()`;
		const { stdout } = await run(process.execPath, [ '--experimental-vm-modules', binary, 'eval', '-e', source ], {
			cwd: directory,
			timeout: 8000,
		});
		return JSON.parse(stdout) as ConfigInspection;
	} finally {
		await fs.rm(directory, { recursive: true, force: true });
	}
}

describe('mods/speedrun-season2', () => {
	test('global claim and ruin rules reuse season 1; main only adds independent scoring', () => {
		assert.deepStrictEqual(manifest.dependencies, [ season1Mod ]);
		assert.deepStrictEqual(manifest.provides, [ 'backend', 'config', 'main', 'processor', 'test' ]);
	});

	test('the real loader loads each season once, with season 1 first', () => {
		const loaded = mods.filter(mod => /\/speedrun(?:-season2)?\/index\.js$/.test(mod.url));
		assert.strictEqual(loaded.length, 2);
		assert.match(loaded[0]!.url, /\/speedrun\/index\.js$/);
		assert.match(loaded[1]!.url, /\/speedrun-season2\/index\.js$/);
		assert.deepStrictEqual(Object.keys(loaded[1]!.provides), [ 'backend', 'config', 'main', 'processor', 'test' ]);
		assert.ok(config.speedrun);
		assert.ok(config.speedrunSeason2);
	});

	test('season 2 owns its defaults and initialization root', () => {
		assert.deepStrictEqual(initializationDefaults, { speedrunSeason2: expectedDefaults });
		assert.deepStrictEqual(makeInitializationDefaults().speedrunSeason2, expectedDefaults);
		assert.notStrictEqual(initializationDefaults.speedrunSeason2, season1Defaults.speedrun);
		assert.notStrictEqual(initializationDefaults.speedrunSeason2.raceBrackets, season1Defaults.speedrun.raceBrackets);
	});

	test('schema and configuration defaults agree for every supported setting', () => {
		const properties = schema.properties.speedrunSeason2.properties;
		assert.deepStrictEqual(Object.keys(properties).sort(), Object.keys(expectedDefaults).sort());
		for (const key of Object.keys(properties) as (keyof typeof properties)[]) {
			assert.deepStrictEqual(properties[key].default, expectedDefaults[key]);
		}
		assert.ok(validate(initializationDefaults), JSON.stringify(validate.errors));
	});

	test('schema accepts partial settings and integer tick options', () => {
		assert.ok(validate({ speedrunSeason2: {} }));
		assert.ok(validate({ speedrunSeason2: { invaders: true, raceBrackets: [], respawnAfter: 0 } }));
		assert.ok(validate({ speedrunSeason2: { raceBrackets: [ 20, 40 ], respawnAfter: -1 } }));
	});

	for (const [ key, value ] of [
		[ 'invaders', 'false' ],
		[ 'respawnCleanup', null ],
		[ 'raceBrackets', [ 20.5, 40 ] ],
		[ 'respawnAfter', 40.5 ],
	] as const) {
		test(`schema rejects an invalid ${key} value`, () => {
			assert.strictEqual(validate({ speedrunSeason2: { [key]: value } }), false);
		});
	}

	test('global switches and core-map settings do not belong to season 2', () => {
		for (const key of [ 'deposits', 'powerBanks', 'claimController', 'ruins', 'closeCenterNine', 'wallSectorCores' ]) {
			assert.strictEqual(validate({ speedrunSeason2: { [key]: false } }), false, key);
		}
	});

	test('all 81 eastern rooms belong only to season 2', () => {
		for (let xx = 1; xx <= 9; ++xx) {
			for (let yy = 1; yy <= 9; ++yy) {
				const name = `E${xx}N${yy}`;
				assert.strictEqual(isSeason2Room(name), true, name);
				assert.strictEqual(isSpeedrunRoom(name), false, name);
				assert.strictEqual(isSeason2Room(`W${xx}N${yy}`), false);
			}
		}
	});

	test('highways, other sectors and malformed names are excluded', () => {
		for (const name of [
			undefined, '', 'E0N3', 'E3N0', 'E10N3', 'E3N10', 'E12N1', 'E3S3',
			'W3N3', 'E03N3', 'E3N03', 'e3n3', ' E3N3', 'E3N3 ', 'E3N3extra', 'E3N3\n',
		]) {
			assert.strictEqual(isSeason2Room(name), false, String(name));
			assert.strictEqual(isSeason2SpawnRoom(name), false, String(name));
		}
	});

	test('the spawn eligibility helper selects E3N3 only', () => {
		assert.strictEqual(season2SpawnRoom, 'E3N3');
		for (let xx = 1; xx <= 9; ++xx) {
			for (let yy = 1; yy <= 9; ++yy) {
				const name = `E${xx}N${yy}`;
				assert.strictEqual(isSeason2SpawnRoom(name), name === 'E3N3', name);
			}
		}
	});

	test('season-1-only deployment does not load the extension or its defaults', async () => {
		const result = await inspectConfig({ mods: [ season1Mod ] });
		assert.deepStrictEqual(result.speedrun, season1Defaults.speedrun);
		assert.strictEqual(result.speedrunSeason2, undefined);
		assert.deepStrictEqual(result.seasonMods.map(mod => mod.name), [ 'speedrun' ]);
	});

	test('listing only the extension loads its season-1 dependency once', async () => {
		const result = await inspectConfig({ mods: [ season2Mod ] });
		assert.deepStrictEqual(result.speedrunSeason2, expectedDefaults);
		assert.deepStrictEqual(result.speedrun, season1Defaults.speedrun);
		assert.deepStrictEqual(result.seasonMods.map(mod => mod.name), [ 'speedrun', 'speedrun-season2' ]);
		assert.deepStrictEqual(result.seasonMods[1]!.providers, [ 'backend', 'config', 'main', 'processor', 'test' ]);
	});

	test('explicit dual-season overrides stay in their own roots', async () => {
		const speedrun = { invaders: true, ruins: true, raceBrackets: [ 200, 400 ], respawnAfter: 400 };
		const speedrunSeason2 = { invaders: false, raceBrackets: [ 20, 40 ], respawnAfter: 40 };
		const result = await inspectConfig({ mods: [ season1Mod, season2Mod ], speedrun, speedrunSeason2 });
		assert.deepStrictEqual(result.speedrun, { ...season1Defaults.speedrun, ...speedrun });
		assert.deepStrictEqual(result.speedrunSeason2, { ...expectedDefaults, ...speedrunSeason2 });
		assert.deepStrictEqual(result.seasonMods.map(mod => mod.name), [ 'speedrun', 'speedrun-season2' ]);
	});

	test('omitted season-2 settings never fall back to season 1', async () => {
		const speedrun = { invaders: true, ruins: true, respawnCleanup: false, raceBrackets: [ 2, 4 ], respawnAfter: 4, claimController: true };
		const result = await inspectConfig({ mods: [ season1Mod, season2Mod ], speedrun });
		assert.deepStrictEqual(result.speedrunSeason2, expectedDefaults);
		assert.deepStrictEqual(result.speedrun, { ...season1Defaults.speedrun, ...speedrun });
	});

	test('invalid season-2 configuration fails in the real startup pipeline', async () => {
		await assert.rejects(
			inspectConfig({ mods: [ season1Mod, season2Mod ], speedrunSeason2: { invaders: 'false' } }),
			/speedrunSeason2\/invaders must be boolean/,
		);
	});

	for (const key of [ 'claimController', 'ruins' ]) {
		test(`the real loader rejects the removed season-2 ${key} switch`, async () => {
			await assert.rejects(
				inspectConfig({ mods: [ season2Mod ], speedrunSeason2: { [key]: false } }),
				/speedrunSeason2 must NOT have additional properties/,
			);
		});
	}
});
