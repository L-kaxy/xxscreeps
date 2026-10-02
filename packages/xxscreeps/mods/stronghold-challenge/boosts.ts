import type { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import type { ResourceType } from 'xxscreeps/mods/classic/resource/resource.js';
import { calculateCarry } from 'xxscreeps/mods/classic/creep/creep.js';
import * as C from 'xxscreeps:mods/constants';

type BoostEffects = Record<string, number | undefined>;
type BoostLookup = Record<string, Record<string, BoostEffects | undefined> | undefined>;

/** Apply a validated boost plan and update capacity. Costs and lab ordering belong to the caller. */
export function applyCreepBoosts(creep: Creep, boosts: Iterable<readonly [ number, ResourceType ]>) {
	const plan = [ ...boosts ];
	const lookup: BoostLookup = C.BOOSTS;
	const indices = new Set<number>();
	for (const [ index, mineral ] of plan) {
		const part = creep.body[index];
		if (!Number.isInteger(index) || part === undefined || part.boost !== undefined
			|| lookup[part.type]?.[mineral] === undefined || indices.has(index)) {
			throw new Error(`Invalid boost plan for body part ${index}`);
		}
		indices.add(index);
	}
	for (const [ index, mineral ] of plan) {
		creep.body[index]!.boost = mineral;
	}
	creep.store['#capacity'] = calculateCarry(creep.body);
}
