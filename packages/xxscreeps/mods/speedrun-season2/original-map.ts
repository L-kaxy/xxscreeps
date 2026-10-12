import type { ResourceType } from 'xxscreeps/mods/classic/resource/resource.js';
import { createHash } from 'node:crypto';
import { RoomObject } from 'xxscreeps/game/object.js';
import { RoomPosition } from 'xxscreeps/game/position.js';
import { Room } from 'xxscreeps/game/room/index.js';
import { TerrainWriter, packExits } from 'xxscreeps/game/terrain.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { StructureExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { Mineral } from 'xxscreeps/mods/classic/mineral/mineral.js';
import { kSourceKeeperUserId } from 'xxscreeps/mods/classic/source/game.js';
import { StructureKeeperLair } from 'xxscreeps/mods/classic/source/keeper-lair.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { computeRoomMeta } from 'xxscreeps/mods/modern/sector/terrain.js';
import { isSpeedrunRoom } from 'xxscreeps/mods/speedrun/scope.js';
import * as C from 'xxscreeps:mods/constants';
import asset from './assets/original-map.json' with { type: 'json' };

export interface InitialMapObject {
	id: string;
	type: 'source' | 'controller' | 'mineral' | 'keeperLair' | 'extractor';
	x: number;
	y: number;
	energy?: number;
	energyCapacity?: number;
	mineralType?: ResourceType;
	mineralAmount?: number;
	density?: number;
}

interface OriginalMap {
	format: number;
	source: { package: string; version: string; file: string; sha256: string };
	rooms: Record<string, { terrain: string; objects: InitialMapObject[] }>;
}

/** Vendored terrain and natural layout only: no users, bot spawns, code or ownership. */
export const originalMap = asset as OriginalMap;

/** Eastward translation by eleven signed room coordinates; tile coordinates never change. */
export function translateOriginalRoom(name: string) {
	if (!isSpeedrunRoom(name)) {
		throw new Error(`Not an original interior room: ${name}`);
	}
	return `E${10 - Number(name[1])}N${name[3]}`;
}

export const season2MapRooms = Object.keys(originalMap.rooms).map(translateOriginalRoom).sort();

/** 24 hex characters fit the engine ID format. An occupied ID is deterministically re-salted. */
export function translatedObjectId(room: string, originalId: string, attempt = 0) {
	return createHash('sha256').update(`speedrun-season2/${room}/${originalId}/${attempt}`).digest('hex').slice(0, 24);
}

function makeObject(info: InitialMapObject) {
	switch (info.type) {
		case 'source': {
			const object = new Source();
			object.energy = info.energy!;
			object.energyCapacity = info.energyCapacity!;
			return object;
		}
		case 'controller':
			return new StructureController();
		case 'mineral': {
			const object = new Mineral();
			object.mineralType = info.mineralType!;
			object.mineralAmount = info.mineralAmount!;
			object.density = info.density!;
			return object;
		}
		case 'keeperLair': {
			const object = new StructureKeeperLair();
			object['#user'] = kSourceKeeperUserId;
			return object;
		}
		case 'extractor': {
			const object = new StructureExtractor();
			object['#user'] = null;
			object.hits = C.EXTRACTOR_HITS;
			return object;
		}
		default:
			throw new Error(`Unsupported initial map object: ${String(info.type)}`);
	}
}

/** No room generator, payload markers, exit repair, connectivity or spawn-space checks. */
export function buildSeason2Map(existingRooms: ReadonlySet<string>, occupiedIds: ReadonlySet<string> = new Set()) {
	const ids = new Set(occupiedIds);
	const roomNames = new Set([ ...existingRooms, ...season2MapRooms ]);
	const rooms: Room[] = [];
	const terrain = new Map<string, ReturnType<typeof computeRoomMeta> & { exits: number; terrain: TerrainWriter }>();
	for (const [ name, initial ] of Object.entries(originalMap.rooms)) {
		if (initial.terrain.length !== 2500 || /[^0-3]/.test(initial.terrain)) {
			throw new Error(`Invalid 2500-tile terrain in ${name}`);
		}
		const translated = translateOriginalRoom(name);
		const tiles = new TerrainWriter();
		for (let index = 0; index < 2500; ++index) {
			tiles.set(index % 50, Math.floor(index / 50), Number(initial.terrain[index]));
		}
		const room = new Room();
		room.name = translated;
		const hasController = initial.objects.some(object => object.type === 'controller');
		room['#user'] = hasController ? null : undefined;
		room['#level'] = hasController ? 0 : -1;
		for (const info of initial.objects) {
			if (!Number.isInteger(info.x) || !Number.isInteger(info.y) || info.x < 0 || info.x > 49 || info.y < 0 || info.y > 49) {
				throw new Error(`Invalid object coordinates in ${name}`);
			}
			const object: RoomObject = makeObject(info);
			let attempt = 0;
			let id: string;
			do {
				id = translatedObjectId(translated, info.id, attempt++);
			} while (ids.has(id));
			ids.add(id);
			object.id = id;
			object.pos = new RoomPosition(info.x, info.y, translated);
			object['#posId'] = object.pos['#id'];
			room['#insertObject'](object);
		}
		room['#flushObjects'](null);
		rooms.push(room);
		terrain.set(translated, { exits: packExits(tiles), terrain: tiles, ...computeRoomMeta(translated, roomNames) });
	}
	return { rooms, terrain };
}
