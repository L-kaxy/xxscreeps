import type { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { OPERATE_SPAWN_LEVEL, PWR_OPERATE_SPAWN } from './constants.js';
import { isChallengeHome } from './layout.js';

export { isChallengeHome } from './layout.js';

/** A rule-owned power has no expiration or remaining-duration field. */
export interface PermanentSpawnEffect {
	effect: number;
	level: number;
}

/** Game API, incubation, and backend rendering query this same immutable rule. */
export function getChallengeSpawnEffect(spawn: StructureSpawn): PermanentSpawnEffect | undefined {
	return isChallengeHome(spawn.room) ? { effect: PWR_OPERATE_SPAWN, level: OPERATE_SPAWN_LEVEL } : undefined;
}
