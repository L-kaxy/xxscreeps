import type { SectorControl } from 'xxscreeps/mods/modern/sector/schema.js';
import { makeSignedRoomName, parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { roomType } from 'xxscreeps/mods/modern/sector/terrain.js';

/**
 * A loaded shard's terrain records -- `(await shard.loadWorld()).terrain`, the same records
 * `iterateSectors(world)` walks. Only `sectorControl` is read here.
 */
export type WorldTerrain = ReadonlyMap<string, { sectorControl?: SectorControl | undefined }>;

/**
 * The rooms of every sector core: the center room plus its eight neighbours, i.e. the central 3x3 of
 * each sector. The walls rule and the closure rule work off this same geometry; the only difference
 * between them is which rooms they are allowed to pick.
 *
 * The world already carries that geometry: `sectorControl` is stamped on every center room when the
 * world is built (`mods/modern/sector/schema.ts`, via `computeRoomMeta`), with `members` the 9x9
 * interior at range <= 4 (the center among them) and `edges` the highway ring at range 5. So the
 * core is read out of the world rather than derived from room names: any name-based rule has to
 * re-derive `parseSignedRoomName`'s W/N convention (`W5` is -6, not -5, per `game/room/name.ts:59`),
 * and getting it wrong shifts the whole 3x3 one room diagonally.
 */
export function sectorCoreRooms(terrain: WorldTerrain): string[] {
	const inside = new Set(terrain.keys());
	const centers = sectorCenters(terrain);
	// A world with no sector records at all -- a hand-built test fixture, or a shard imported without
	// the sector mod -- has no geometry to read, so fall back to the classifier the generator itself
	// uses to lay a sector out.
	return centers.length === 0 ? classifyByRoomType(inside) : coreAround(centers, inside);
}

/**
 * The sector cores, restricted to rooms which the caller listed. Rooms absent from `open` -- already
 * closed, or outside the world -- are never returned, so this can drop rooms from the world but
 * never invent one.
 */
export function roomsToClose(terrain: WorldTerrain, open: Iterable<string>): string[] {
	const openSet = new Set(open);
	const centers = sectorCenters(terrain);
	return centers.length === 0 ? classifyByRoomType(open) : coreAround(centers, openSet);
}

function sectorCenters(terrain: WorldTerrain): string[] {
	const centers = [];
	for (const [ name, { sectorControl } ] of terrain) {
		if (sectorControl !== undefined) {
			centers.push(name);
		}
	}
	return centers;
}

function coreAround(centers: Iterable<string>, candidates: ReadonlySet<string>): string[] {
	const core = new Set<string>();
	for (const center of centers) {
		const { rx, ry } = parseSignedRoomName(center);
		for (let dx = -1; dx <= 1; ++dx) {
			for (let dy = -1; dy <= 1; ++dy) {
				const name = makeSignedRoomName(rx + dx, ry + dy);
				if (candidates.has(name)) {
					core.add(name);
				}
			}
		}
	}
	return [ ...core ];
}

function classifyByRoomType(names: Iterable<string>): string[] {
	return [ ...names ].filter(name => {
		const type = roomType(name);
		return type === 'center' || type === 'sourceKeeper';
	});
}
