import { hooks, spawnRules } from 'xxscreeps/mods/classic/spawn/rules.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { extend } from 'xxscreeps/utility/utility.js';
import { OPERATE_SPAWN_MULTIPLIER } from './constants.js';
import { getChallengeSpawnEffect, isChallengeHome } from './spawn-effects.js';

spawnRules.register({ forSpawn: spawn => ({ freeEnergy: isChallengeHome(spawn.room) }) });
hooks.register('spawnTimeMultiplier', spawn => getChallengeSpawnEffect(spawn) === undefined ? 1 : OPERATE_SPAWN_MULTIPLIER);

extend(StructureSpawn, {
	effects: cached(StructureSpawn.prototype, 'effects', {
		enumerable: true,
		get(this: StructureSpawn) {
			const effects = [ ...this['#effects']() ];
			const permanent = getChallengeSpawnEffect(this);
			if (permanent !== undefined) {
				return [ ...effects, permanent ];
			}
			return effects.length > 0 ? effects : undefined;
		},
	}),
});
