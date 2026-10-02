import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import type { RoomPosition } from 'xxscreeps/game/position.js';
import type { Room } from 'xxscreeps/game/room/index.js';
import { Game } from 'xxscreeps/game/index.js';
import { kInvaderUserId } from 'xxscreeps/mods/classic/invader/game.js';
import { create as createInvaderCore } from 'xxscreeps/mods/modern/stronghold/invader-core.js';
import { deployStronghold } from 'xxscreeps/mods/modern/stronghold/processor.js';
import { templates } from 'xxscreeps/mods/modern/stronghold/templates.js';
import { activateNPC } from 'xxscreeps/mods/npc/processor.js';
import * as C from 'xxscreeps:mods/constants';

export interface CreateStrongholdOptions {
	position: RoomPosition;
	level: number;
	templateName: keyof typeof templates;
	/** Omitted deploys immediately; a future tick starts the normal deploy stage. */
	deployTime?: number;
}

/** Author a challenge core, then use the native stronghold deployment for all peers and lifetime. */
export function createStronghold(room: Room, context: ProcessorContext, options: CreateStrongholdOptions) {
	const { position, level, templateName } = options;
	if (position.roomName !== room.name || templates[templateName].rewardLevel !== level) {
		throw new Error('Stronghold room, level and template must agree');
	}
	const terrain = room.getTerrain();
	for (const entry of [ { dx: 0, dy: 0 }, ...templates[templateName].structures ]) {
		const xx = position.x + entry.dx;
		const yy = position.y + entry.dy;
		if (xx <= 0 || yy <= 0 || xx >= 49 || yy >= 49 || terrain.get(xx, yy) === C.TERRAIN_MASK_WALL) {
			throw new Error('Stronghold template must fit on walkable room interior');
		}
	}
	if (options.deployTime !== undefined && options.deployTime !== 0 &&
		(!Number.isSafeInteger(options.deployTime) || options.deployTime <= Game.time)) {
		throw new Error('Stronghold deploy time must be a future tick');
	}
	const core = createInvaderCore(position, level, options.deployTime ?? 0);
	core['#templateName'] = templateName;
	room['#insertObject'](core);
	if (options.deployTime === undefined || options.deployTime === 0) {
		deployStronghold(core, context);
	}
	activateNPC(room, kInvaderUserId);
	context.setActive();
	return core;
}
