import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { registerObjectTickProcessor } from 'xxscreeps/engine/processor/index.js';
import { intentProcessors } from 'xxscreeps/engine/processor/symbols.js';
import { Game, me } from 'xxscreeps/game/index.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { makeHookRegistration } from 'xxscreeps/utility/hook.js';

// Chain the installed handlers, as speedrun does, instead of replacing native handover or birth.
export const hooks = makeHookRegistration<{
	didPlaceSpawn: (room: Room, context: ProcessorContext, spawn: StructureSpawn) => void;
	didUnspawn: (room: Room, context: ProcessorContext, userId: string) => void;
	didBirthCreep: (owner: StructureSpawn, creep: Creep, context: ProcessorContext) => void;
}>();

const didPlaceSpawn = hooks.makeIterated('didPlaceSpawn');
const didUnspawn = hooks.makeIterated('didUnspawn');
const didBirthCreep = hooks.makeIterated('didBirthCreep');

function roomIntent(name: string) {
	const intent = intentProcessors.find(info => info.intent === name && info.receiver === Room);
	if (intent === undefined) {
		throw new Error(`Challenge requires the native ${name} room intent`);
	}
	return intent;
}

const landing = roomIntent('placeSpawn');
const placeSpawn = landing.process;
landing.process = (room: Room, context: ProcessorContext, xx: number, yy: number, name: string) => {
	const wasNeutral = room['#user'] === null;
	placeSpawn(room, context, xx, yy, name);
	if (wasNeutral && room['#user'] === me) {
		const spawn = [ ...room['#immediateObjects']() ].find((object): object is StructureSpawn =>
			object instanceof StructureSpawn && object['#user'] === me && object.name === name);
		if (spawn === undefined) {
			throw new Error('Successful landing must have its starting spawn');
		}
		didPlaceSpawn(room, context, spawn);
	}
};

const respawn = roomIntent('unspawn');
const unspawn = respawn.process;
respawn.process = (room: Room, context: ProcessorContext) => {
	const userId = me;
	const wasUsing = room['#user'] === userId || room['#objects'].some(object => object['#user'] === userId);
	unspawn(room, context);
	if (wasUsing) {
		didUnspawn(room, context, userId);
	}
};

/** Undo a rejected competing landing through the same native handover and challenge cleanup. */
export function unspawnPlayerRoom(room: Room, context: ProcessorContext, userId: string) {
	if (userId !== me) {
		throw new Error('Landing rollback must run in its player context');
	}
	respawn.process(room, context);
}

registerObjectTickProcessor(StructureSpawn, (spawn, context, next) => {
	const spawning = spawn.spawning;
	const creep = spawning === null ? null : Game.getObjectById<Creep>(spawning['#spawningCreepId']);
	next();
	if (spawning !== null && spawn.spawning === null && creep instanceof Creep && !creep.spawning) {
		didBirthCreep(spawn, creep, context);
	}
});
