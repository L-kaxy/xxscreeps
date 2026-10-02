import type { StructureSpawn } from './spawn.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { makeHookRegistration, makeProviderRegistration } from 'xxscreeps/utility/hook.js';
import * as C from 'xxscreeps:mods/constants';

export interface SpawnRules {
	/** Free spawning still validates ownership, body, name and activity. */
	freeEnergy: boolean;
}

export interface SpawnRuleProvider {
	forSpawn: (spawn: StructureSpawn) => SpawnRules;
}

/** The same rule source is read by the player API and the intent processor. */
export const spawnRules = makeProviderRegistration<SpawnRuleProvider>('spawn rules', {
	forSpawn: () => ({ freeEnergy: false }),
});

export const hooks = makeHookRegistration<{
	/** The strongest speed improvement wins; improvements do not stack. */
	spawnTimeMultiplier: (spawn: StructureSpawn) => number;
}>();

const spawnTimeMultipliers = hooks.makeMapped('spawnTimeMultiplier');

export const getSpawnRules = (spawn: StructureSpawn) => spawnRules.current.forSpawn(spawn);

/** Total incubation ticks, rounded up with at least one processing tick. */
export function spawnTime(spawn: StructureSpawn, bodyLength: number) {
	const multiplier = Fn.reduce(spawnTimeMultipliers(spawn), 1, (current, value) => {
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error(`Invalid spawn time multiplier ${value}`);
		}
		return Math.min(current, value);
	});
	return Math.max(1, Math.ceil(bodyLength * C.CREEP_SPAWN_TIME * multiplier));
}
