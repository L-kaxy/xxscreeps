import type { Room } from 'xxscreeps/game/room/index.js';
import type { RoomObject } from 'xxscreeps/game/object.js';
import type { ResourceType } from 'xxscreeps/mods/classic/resource/resource.js';
import type { ObjectPlan, PlanTile } from './template.js';
import * as C from 'xxscreeps:mods/constants';
import { createRoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { Mineral } from 'xxscreeps/mods/classic/mineral/mineral.js';
import { StructureExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { hasStandingRoom, planTiles } from './template.js';

/**
 * The object half of the uniform world: every covered room is given the plan's sources, mineral and
 * controller, so no room has a source in a corner while another has one walled in.
 *
 * A planned tile is ground the template left walkable, so an object placed on it always has somewhere
 * for a creep to stand and the room's yield no longer depends on where the room's own layout happened
 * to drop a source. What the room holds beyond that -- spawns, walls, roads, creeps -- is never
 * touched; a planned tile another object already stands on is nudged to the nearest free ground
 * instead, and the room is reported so the operator can see it happened.
 */

export interface PlaceRequest {
	/** How many sources every covered room ends up with. */
	sources: number;
	/** When set, every covered room's mineral becomes this type; unset leaves each room's own. */
	mineral?: ResourceType;
}

export interface PlaceReport {
	/** Objects which stood somewhere else and were moved onto their planned tile. */
	moved: number;
	/** Objects which had to be made, so a room could carry what the plan asks for. */
	added: number;
	/** Sources above the requested count, taken out of the room. */
	removed: number;
	/** Objects which took the nearest free ground because their planned tile was in use. */
	nudged: number;
	/** Rooms where an object could not be given a tile at all; it was left where it stood. */
	blocked: string[];
}

/** The objects of one covered room, in the pieces the plan hands them out in. */
function collect(room: Room) {
	const objects = [ ...room['#objects'] ];
	return {
		objects,
		sources: objects.filter((object): object is Source => object instanceof Source)
			.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
		minerals: objects.filter((object): object is Mineral => object instanceof Mineral),
		controllers: objects.filter((object): object is StructureController => object instanceof StructureController),
		extractors: objects.filter((object): object is StructureExtractor => object instanceof StructureExtractor),
	};
}

function tileOf(object: RoomObject): PlanTile {
	return { x: object.pos.x, y: object.pos.y };
}

function sameTile(left: PlanTile, right: PlanTile) {
	return left.x === right.x && left.y === right.y;
}

function tileKey(tile: PlanTile) {
	return `${tile.x},${tile.y}`;
}

function tileDistance(left: PlanTile, right: PlanTile) {
	return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function makeSource(room: Room, tile: PlanTile) {
	const source = createRoomObject(new Source(), new RoomPosition(tile.x, tile.y, room.name));
	// The same capacity `room-gen` bakes in: a room with a controller runs neutral sources, a room
	// without one keeper-capacity sources. The room's own status rewrites this once it changes.
	source.energy = source.energyCapacity = room.controller === undefined
		? C.SOURCE_ENERGY_KEEPER_CAPACITY
		: C.SOURCE_ENERGY_NEUTRAL_CAPACITY;
	return source;
}

function makeMineral(room: Room, tile: PlanTile, type: ResourceType | undefined) {
	const mineral = createRoomObject(new Mineral(), new RoomPosition(tile.x, tile.y, room.name));
	const density = C.MINERAL_DENSITY_PROBABILITY
		.findIndex(probability => probability !== undefined && Math.random() <= probability);
	mineral.mineralType = type ?? C.RESOURCE_HYDROGEN;
	mineral.density = density > 0 ? density : 1;
	mineral.mineralAmount = C.MINERAL_DENSITY[mineral.density]!;
	return mineral;
}

function makeController(room: Room, tile: PlanTile) {
	room['#level'] = 0;
	room['#user'] = null;
	return createRoomObject(new StructureController(), new RoomPosition(tile.x, tile.y, room.name));
}

/**
 * Gives one covered room the objects the plan asks for, and reports what it had to do. The room is
 * mutated in place; the caller flushes and saves it.
 */
export function placeObjects(
	room: Room,
	plan: ObjectPlan,
	terrain: Readonly<Uint8Array>,
	request: PlaceRequest,
): PlaceReport {
	const report: PlaceReport = { moved: 0, added: 0, removed: 0, nudged: 0, blocked: [] };
	const { objects, sources, minerals, controllers, extractors } = collect(room);
	const mineral = minerals[0];
	const controller = controllers[0];
	// The extractor a room built on its mineral is part of that mineral: it travels with it.
	const extractor = mineral === undefined ? undefined
		: extractors.find(candidate => sameTile(tileOf(candidate), tileOf(mineral)));
	// Everything the plan does not own keeps its tile, so a planned tile already in use is nudged
	// off rather than stacked on. The objects the plan does own are free to leave theirs.
	const owned = new Set<RoomObject>([ ...sources, ...minerals, ...controllers, ...extractors ]);
	const reserved = new Set(objects.filter(object => !owned.has(object)).map(tileOf).map(tileKey));
	// No fallback may take a tile the plan wants for another object.
	const spoken = new Set(plan.sources.map(tileKey));
	spoken.add(tileKey(plan.mineral));
	spoken.add(tileKey(plan.controller));
	const ground = planTiles(terrain);
	const take = (tile: PlanTile): PlanTile | undefined => {
		if (!reserved.has(tileKey(tile))) {
			return tile;
		}
		const fallback = ground
			.filter(candidate => !reserved.has(tileKey(candidate)) && !spoken.has(tileKey(candidate)))
			.sort((left, right) => tileDistance(left, tile) - tileDistance(right, tile))[0];
		if (fallback === undefined) {
			return undefined;
		}
		spoken.add(tileKey(fallback));
		++report.nudged;
		return fallback;
	};
	const move = (object: RoomObject, tile: PlanTile) => {
		if (!sameTile(tileOf(object), tile)) {
			room['#moveObject'](object, new RoomPosition(tile.x, tile.y, room.name));
			++report.moved;
		}
	};
	const blocked = () => {
		report.blocked.push(room.name);
	};

	// Sources: the room's own are kept and moved, extras are dropped, missing ones are made.
	for (const [ index, source ] of sources.entries()) {
		if (index >= request.sources) {
			room['#removeObject'](source);
			++report.removed;
			continue;
		}
		const tile = take(plan.sources[index]!);
		if (tile === undefined) {
			blocked();
		} else {
			move(source, tile);
		}
	}
	for (let index = sources.length; index < request.sources; ++index) {
		const tile = take(plan.sources[index]!);
		if (tile === undefined) {
			blocked();
		} else {
			room['#insertObject'](makeSource(room, tile));
			++report.added;
		}
	}

	// Mineral: one per room, moved with the extractor built on it. Extras are dropped.
	if (mineral === undefined) {
		const tile = take(plan.mineral);
		if (tile === undefined) {
			blocked();
		} else {
			room['#insertObject'](makeMineral(room, tile, request.mineral));
			++report.added;
		}
	} else {
		for (const extra of minerals.slice(1)) {
			room['#removeObject'](extra);
			++report.removed;
		}
		const tile = take(plan.mineral);
		if (tile === undefined) {
			blocked();
		} else {
			move(mineral, tile);
			if (request.mineral !== undefined && mineral.mineralType !== request.mineral) {
				mineral.mineralType = request.mineral;
			}
			if (extractor !== undefined) {
				move(extractor, tile);
			}
		}
	}

	// Controller: moved, never created over an owner's and never removed.
	if (controller === undefined) {
		const tile = take(plan.controller);
		if (tile === undefined) {
			blocked();
		} else {
			room['#insertObject'](makeController(room, tile));
			++report.added;
		}
	} else {
		const tile = take(plan.controller);
		if (tile === undefined) {
			blocked();
		} else {
			move(controller, tile);
		}
	}
	if (report.moved + report.added + report.removed !== 0) {
		// Flush the queues so the caller can serialize the room as it now stands. Nothing else about
		// the room changes: no object's owner moves with it, so its user relationships stay put.
		room['#flushObjects'](null);
	}
	return report;
}

/**
 * Whether a room already holds exactly what the plan asks for: its sources on the plan's tiles, one
 * mineral -- with its extractor, when it has one -- and one controller. Read off the room, like
 * `isUniform` reads the terrain, so a second run writes nothing.
 *
 * The sources are matched as a set of tiles, not in id order: a source the pass made carries an id
 * from the middle of the id space, so id order and plan order part ways the moment a room gets one,
 * and a second run would shuffle every source back and forth forever.
 */
export function objectsMatch(room: Room, plan: ObjectPlan, request: PlaceRequest): boolean {
	const { sources, minerals, controllers } = collect(room);
	if (sources.length !== request.sources || minerals.length !== 1 || controllers.length !== 1) {
		return false;
	}
	const wanted = new Set(plan.sources.map(tile => tileKey(tile)));
	if (!sources.every(source => wanted.has(tileKey(tileOf(source))))) {
		return false;
	}
	const mineral = minerals[0]!;
	if (!sameTile(tileOf(mineral), plan.mineral) || !sameTile(tileOf(controllers[0]!), plan.controller)) {
		return false;
	}
	return request.mineral === undefined || mineral.mineralType === request.mineral;
}

/** The objects of one room which would have nowhere to work from, as the report tallies them. */
export function objectLosses(room: Room, terrain: Readonly<Uint8Array>) {
	const { sources, minerals, controllers } = collect(room);
	let usable = 0;
	for (const source of sources) {
		usable += hasStandingRoom(terrain, source.pos.x, source.pos.y) ? 1 : 0;
	}
	return {
		sources: sources.filter(source => !hasStandingRoom(terrain, source.pos.x, source.pos.y)).length,
		minerals: minerals.filter(mineral => !hasStandingRoom(terrain, mineral.pos.x, mineral.pos.y)).length,
		controllers: controllers.filter(controller => !hasStandingRoom(terrain, controller.pos.x, controller.pos.y)).length,
		/** A room with sources but not one of them reachable: it cannot be harvested at all. */
		sourceLess: sources.length !== 0 && usable === 0,
	};
}
