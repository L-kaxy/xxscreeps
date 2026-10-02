import { Render } from 'xxscreeps/backend/symbols.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { create as createTower } from 'xxscreeps/mods/classic/defense/tower.js';
import { lookForStructures } from 'xxscreeps/mods/classic/structure/structure.js';
import { create as createCore } from 'xxscreeps/mods/modern/stronghold/invader-core.js';
import { assert, describe, simulate, test } from 'xxscreeps/test/index.js';
import * as C from 'xxscreeps:mods/constants';

function simulation(paired: boolean) {
	return simulate({
		W1N2: room => {
			room['#challengePair'] = paired ? { home: 'W1N1', stronghold: room.name } : undefined;
			const core = createCore(new RoomPosition(25, 25, room.name), 2, 5000);
			core['#collapseTime'] = 10000;
			room['#insertObject'](core);
			const peer = createTower(new RoomPosition(24, 25, room.name), '2');
			peer['#collapseTime'] = 10000;
			room['#insertObject'](peer);
		},
	});
}

describe('stronghold challenge scoped renderer', () => {
	test('unpaired core and peers retain their native effect output', () => simulation(false)(async ({ poke }) => {
		await poke('W1N2', '100', (_Game, room) => {
			const core = lookForStructures(room, C.STRUCTURE_INVADER_CORE)[0]!;
			const rendered = core[Render]();
			assert.ok(rendered);
			assert.deepStrictEqual('effects' in rendered ? rendered.effects : undefined, [
				{ effect: C.EFFECT_INVULNERABILITY, endTime: 5000, duration: 5000 },
			]);
			const peer = lookForStructures(room, C.STRUCTURE_TOWER)[0]![Render]();
			assert.ok(peer);
			assert.strictEqual('effects' in peer ? peer.effects : undefined, undefined);
		});
	}));

	test('paired core and peers share the exact deadline while the core retains its deploy timer', () => simulation(true)(async ({ poke }) => {
		await poke('W1N2', '100', (_Game, room) => {
			const core = lookForStructures(room, C.STRUCTURE_INVADER_CORE)[0]!;
			const collapse = { effect: C.EFFECT_COLLAPSE_TIMER, endTime: 10000, duration: C.STRONGHOLD_DECAY_TICKS };
			const rendered = core[Render]();
			assert.ok(rendered);
			assert.deepStrictEqual('effects' in rendered ? rendered.effects : undefined, [
				{ effect: C.EFFECT_INVULNERABILITY, endTime: 5000, duration: 5000 }, collapse,
			]);
			const peer = lookForStructures(room, C.STRUCTURE_TOWER)[0]![Render]();
			assert.ok(peer);
			assert.deepStrictEqual('effects' in peer ? peer.effects : undefined, [ collapse ]);
			core['#deployTime'] = 0;
			const deployed = core[Render]();
			assert.ok(deployed);
			assert.deepStrictEqual('effects' in deployed ? deployed.effects : undefined, [ collapse ]);
		});
	}));
});
