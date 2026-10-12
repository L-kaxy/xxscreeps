import { TERRAIN_MASK_SWAMP, TERRAIN_MASK_WALL, TerrainWriter, getBuffer } from 'xxscreeps/game/terrain.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { hasStandingRoom, isUniform, planTiles, templateExitWidth } from './template.js';

const combined = TERRAIN_MASK_WALL | TERRAIN_MASK_SWAMP;

describe('speedrun terrain bitmasks', () => {
	test('template exit width excludes combined wall tiles', () => {
		const terrain = new TerrainWriter(new Uint8Array(625).fill(0xff));
		assert.strictEqual(templateExitWidth(getBuffer(terrain)), 0);
		terrain.set(25, 0, TERRAIN_MASK_SWAMP);
		assert.strictEqual(templateExitWidth(getBuffer(terrain)), 1);
	});

	test('standing room excludes combined walls but allows pure swamp', () => {
		const terrain = new TerrainWriter(new Uint8Array(625).fill(0xff));
		assert.strictEqual(hasStandingRoom(getBuffer(terrain), 25, 25), false);
		terrain.set(26, 25, TERRAIN_MASK_SWAMP);
		assert.strictEqual(hasStandingRoom(getBuffer(terrain), 25, 25), true);
	});

	test('object planning recognizes combined wall tiles with walkable neighbors', () => {
		const terrain = new TerrainWriter();
		terrain.set(25, 25, combined);
		assert.deepStrictEqual(planTiles(getBuffer(terrain)), [ { x: 25, y: 25 } ]);
	});

	test('uniform ring verification rejects combined walls on an expected opening', () => {
		const template = new TerrainWriter();
		const ring = new TerrainWriter();
		const terrain = new Map([
			[ 'W1N1', { exits: 15, terrain: template } ],
			[ 'W0N1', { exits: 15, terrain: ring } ],
		]);
		const layout = { core: [], rooms: [ 'W1N1' ], ring: [ 'W0N1' ] };
		const options = { ringEdges: true, sealCore: false };
		assert.strictEqual(isUniform(terrain, getBuffer(template), layout, options), true);
		ring.set(0, 25, combined);
		assert.strictEqual(isUniform(terrain, getBuffer(template), layout, options), false);
	});
});
