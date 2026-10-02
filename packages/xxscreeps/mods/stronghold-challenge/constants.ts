import * as C from 'xxscreeps:mods/constants';

/** The part of the original power table consumed by this challenge's immutable spawn rule. */
export interface PowerInfo {
	effect: readonly number[];
}

function isPowerInfo(value: unknown): value is PowerInfo {
	return value !== null && typeof value === 'object' && 'effect' in value
		&& Array.isArray(value.effect) && value.effect.every((entry: unknown) => typeof entry === 'number');
}

export const OPERATE_SPAWN_LEVEL = 5;

// The manifest requires mmo/powercreep. Resolve its existing constants at the mod boundary rather
// than copying the power table or importing MMO source into the classic TypeScript project.
const operateSpawn = function() {
	if (!('PWR_OPERATE_SPAWN' in C) || typeof C.PWR_OPERATE_SPAWN !== 'number'
		|| !('POWER_INFO' in C) || C.POWER_INFO === null || typeof C.POWER_INFO !== 'object') {
		throw new Error('Stronghold challenge requires the power creep constants');
	}
	const info: unknown = Reflect.get(C.POWER_INFO, C.PWR_OPERATE_SPAWN);
	if (!isPowerInfo(info)) {
		throw new Error('Stronghold challenge requires the OPERATE_SPAWN power table');
	}
	const multiplier = info.effect[OPERATE_SPAWN_LEVEL - 1];
	if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier <= 0) {
		throw new Error('Invalid OPERATE_SPAWN level five multiplier');
	}
	return { power: C.PWR_OPERATE_SPAWN, multiplier };
}();

export const PWR_OPERATE_SPAWN = operateSpawn.power;
export const OPERATE_SPAWN_MULTIPLIER = operateSpawn.multiplier;
