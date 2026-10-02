import type { ChallengeRun } from './run-schema.js';
import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import type { PartType } from 'xxscreeps/mods/classic/creep/creep.js';
import type { ResourceType } from 'xxscreeps/mods/classic/resource/resource.js';
import { registerIntentProcessor, registerRoomTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { RoomProcessor } from 'xxscreeps/engine/processor/room.js';
import { Game, runWithState } from 'xxscreeps/game/index.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { updateRoomStatus } from 'xxscreeps/mods/classic/controller/controller.js';
import { StructureSpawn, create as createSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import * as C from 'xxscreeps:mods/constants';
import { applyCreepBoosts } from './boosts.js';
import { kStrongholdPosition } from './layout.js';
import { hooks, unspawnPlayerRoom } from './lifecycle.js';
import { publishRun, recordVictory, reserveLanding } from './race.js';
import { createStronghold } from './stronghold.js';

const boosts: Partial<Record<PartType, ResourceType>> = {
	[C.ATTACK]: C.RESOURCE_CATALYZED_UTRIUM_ACID,
	[C.RANGED_ATTACK]: C.RESOURCE_CATALYZED_KEANIUM_ALKALIDE,
	[C.HEAL]: C.RESOURCE_CATALYZED_LEMERGIUM_ALKALIDE,
	[C.TOUGH]: C.RESOURCE_CATALYZED_GHODIUM_ALKALIDE,
	[C.MOVE]: C.RESOURCE_CATALYZED_ZYNTHIUM_ALKALIDE,
	[C.CARRY]: C.RESOURCE_CATALYZED_KEANIUM_ACID,
	[C.WORK]: C.RESOURCE_CATALYZED_ZYNTHIUM_ACID,
};

function clearArena(room: Room, context: ProcessorContext) {
	for (const object of room['#immediateObjects']()) {
		if (object !== room.controller) {
			room['#removeObject'](object);
			context.state.objects.delete(object.id);
		}
	}
	room['#npcData'].users.clear();
	room['#npcData'].memory.clear();
	room['#cumulativeEnergyHarvested'] = 0;
	room['#sign'] = undefined;
	// Invalidate removed receivers before the NPC's already-queued intents can use them.
	room['#flushObjects'](context.state);
	context.didUpdate();
}

function resetTarget(room: Room, context: ProcessorContext, run: ChallengeRun) {
	run.state = 'abandoned';
	context.task(publishRun(context.shard, room.name, { ...run }));
	clearArena(room, context);
	room['#challengeRun'] = undefined;
}

export type ChallengeIntents = typeof intents;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const intents = [
	registerIntentProcessor(Room, 'startStrongholdChallenge', { internal: true },
		(room, context, userId: string, runId: string, startedTick: number, home: string) => {
			const pair = room['#challengePair'];
			if (pair?.stronghold !== room.name || pair.home !== home || room.controller !== undefined) {
				throw new Error('Challenge target must be the paired room without a controller');
			}
			const previous = room['#challengeRun'];
			if (previous !== undefined && previous.startedTick >= startedTick) {
				return;
			}
			clearArena(room, context);
			const core = createStronghold(room, context, {
				position: new RoomPosition(kStrongholdPosition.x, kStrongholdPosition.y, room.name),
				level: 5, templateName: 'bunker5',
			});
			const run = room['#challengeRun'] = {
				userId, runId, startedTick, home, coreId: core.id,
				deadlineTick: core['#collapseTime'], state: 'running', finishedTick: undefined,
			};
			context.task(publishRun(context.shard, room.name, run));
		}),
	registerIntentProcessor(Room, 'resetStrongholdChallenge', { internal: true },
		(room, context, runId: string) => {
			const run = room['#challengeRun'];
			if (run?.runId === runId) {
				resetTarget(room, context, run);
			}
		}),
	registerIntentProcessor(Room, 'resetStrongholdHome', { internal: true },
		(room, context, runId: string) => {
			if (room['#challengeHomeRun']?.runId === runId && room['#user'] == null) {
				room['#challengeHomeRun'] = undefined;
				clearArena(room, context);
			}
		}),
];

hooks.register('didPlaceSpawn', (room, context, spawn) => {
	const pair = room['#challengePair'];
	if (pair?.home !== room.name) {
		return;
	}
	const userId = spawn['#user'];
	if (userId === null) {
		throw new Error('A successful landing must have an owner');
	}
	const controller = room.controller!;
	updateRoomStatus(room, 8, userId);
	controller['#downgradeTime'] = Game.time + C.CONTROLLER_DOWNGRADE[8]!;
	controller['#progress'] = 0;
	room['#safeModeUntil'] = 0;
	// The first spawn belongs to the player's landing. Place two more on the closest free tiles,
	// leaving a tile between spawns whenever possible so all three can hatch squads concurrently.
	const positions = [ ...function*() {
		for (let yy = 1; yy < 49; ++yy) {
			for (let xx = 1; xx < 49; ++xx) {
				const pos = new RoomPosition(xx, yy, room.name);
				if (room.getTerrain().get(xx, yy) !== C.TERRAIN_MASK_WALL && room['#lookAt'](pos).length === 0
					&& spawn.pos.getRangeTo(pos) >= 2) {
					yield pos;
				}
			}
		}
	}() ].sort((left, right) => spawn.pos.getRangeTo(left) - spawn.pos.getRangeTo(right));
	const reserved = new Set([ spawn.name ]);
	const added: RoomPosition[] = [];
	for (let ii = 2; ii <= 3; ++ii) {
		const pos = positions.find(pos => added.every(other => pos.getRangeTo(other) >= 2));
		if (pos === undefined) {
			throw new Error('Challenge home must have space for three spawns');
		}
		const name = function() {
			for (let suffix = ii; ; ++suffix) {
				const candidate = `${spawn.name}-${suffix}`;
				if (!reserved.has(candidate)) {
					return candidate;
				}
			}
		}();
		reserved.add(name);
		added.push(pos);
		room['#insertObject'](createSpawn(pos, userId, name));
	}
	const runId = `${userId}:${Game.time}:${room.name}`;
	room['#challengeHomeRun'] = { userId, runId, startedTick: Game.time };
	const startedTick = Game.time;
	context.task(reserveLanding(context.shard, userId, runId, startedTick, room.name, pair.stronghold), previous => {
		if (previous === undefined) {
			unspawnPlayerRoom(room, context, userId);
			return;
		}
		if (previous.runId !== undefined && previous.runId !== runId) {
			context.sendRoomIntent(previous.targetRoom!, 'resetStrongholdChallenge', previous.runId);
			context.sendRoomIntent(previous.room!, 'resetStrongholdHome', previous.runId);
		}
		context.sendRoomIntent(pair.stronghold, 'startStrongholdChallenge', userId, runId, startedTick, room.name);
	});
	context.didUpdate();
});

hooks.register('didBirthCreep', (owner, creep, context) => {
	if (!(owner instanceof StructureSpawn) || owner.room['#challengePair']?.home !== owner.room.name) {
		return;
	}
	applyCreepBoosts(creep, creep.body.flatMap((part, index) => {
		const boost = boosts[part.type];
		return boost === undefined ? [] : [ [ index, boost ] as const ];
	}));
	context.didUpdate();
});

hooks.register('didUnspawn', (room, context, userId) => {
	const homeRun = room['#challengeHomeRun'];
	if (homeRun?.userId === userId) {
		const pair = room['#challengePair']!;
		context.sendRoomIntent(pair.stronghold, 'resetStrongholdChallenge', homeRun.runId);
		room['#challengeHomeRun'] = undefined;
		clearArena(room, context);
	}
	const run = room['#challengeRun'];
	if (run?.userId === userId) {
		resetTarget(room, context, run);
	}
});

// Suppress unrelated raid generation in the authored arenas without changing combat/NPC behavior.
registerRoomTickProcessor(room => {
	if (room['#challengePair'] !== undefined) {
		room['#cumulativeEnergyHarvested'] = 0;
	}
});

function observeChallengeRun(room: Room, context: ProcessorContext) {
	const run = room['#challengeRun'];
	if (run === undefined || run.state === 'abandoned' || run.state === 'timedOut') {
		return;
	}
	if (Game.time >= run.deadlineTick) {
		run.state = 'timedOut';
		context.task(publishRun(context.shard, room.name, { ...run }));
		context.didUpdate();
		return;
	}
	if (run.state === 'running' && room.getEventLog().some(event =>
		event.event === C.EVENT_OBJECT_DESTROYED && event.objectId === run.coreId)) {
		run.state = 'won';
		run.finishedTick = Game.time;
		context.task(recordVictory(context.shard, room.name, { ...run }));
		context.didUpdate();
	}
	context.wakeAt(run.deadlineTick);
}

// Phase one has finished combat and movement, and its event log is still intact. Queue the
// observation's work before native finalization awaits tasks and saves the room. A challenge
// created by an inter-room intent inside finalize is kept active by createStronghold.
RoomProcessor.prototype.finalize = function(finalize: RoomProcessor['finalize']) {
	return async function(this: RoomProcessor, didWake: boolean) {
		runWithState(this.state, () => observeChallengeRun(this.room, this));
		return finalize.call(this, didWake);
	};
// eslint-disable-next-line @typescript-eslint/unbound-method
}(RoomProcessor.prototype.finalize);
