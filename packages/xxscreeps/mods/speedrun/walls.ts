import type { Terrain } from 'xxscreeps/game/terrain.js';
import { makeSignedRoomName, parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { TERRAIN_MASK_WALL, TerrainWriter, getBuffer, packExits } from 'xxscreeps/game/terrain.js';

/**
 * The fields of a `World.terrain` entry this module rewrites. Everything else on the record -- in
 * particular the `sectorControl` a sector's resource placement hangs off -- is left as it is, which
 * is why a walled core keeps its sector alive. That is the whole point of walling rather than
 * deleting: `mods/modern/deposit` and `mods/modern/powerbank` find their highway rooms by walking
 * the sector records, so a core whose record survives keeps both systems working.
 */
export interface TerrainEntry {
	exits: number;
	terrain: Terrain;
}

/** The four neighbours of a room, as signed coordinate offsets. */
const neighbors = [ [ 0, -1 ], [ 1, 0 ], [ 0, 1 ], [ -1, 0 ] ] as const;

/** Paints every one of a room's 2500 tiles as wall, in place. */
function solid(terrain: Terrain) {
	const writer = new TerrainWriter(getBuffer(terrain));
	for (let yy = 0; yy < 50; ++yy) {
		for (let xx = 0; xx < 50; ++xx) {
			writer.set(xx, yy, TERRAIN_MASK_WALL);
		}
	}
}

/**
 * Turns the sector cores into solid rock and seals the ring of rooms around them.
 *
 * A solid room on its own would not keep anybody out. Crossing a room border is not validated
 * against the room being entered: `mods/classic/creep/processor.ts` hands a creep over as soon as it
 * is standing on a border tile, and the `import` intent which carries it is applied without looking
 * at terrain. The check that can refuse the step is the one in `engine/processor/movement.ts`,
 * which tests the terrain of the room the creep is *leaving* -- so the wall which actually stops it
 * is the one on the neighbouring room's facing edge. Both are painted here.
 *
 * `exits` -- the bitfield `describeExits` and the route finder read -- is recomputed from the
 * painted terrain rather than patched bit by bit, so a sealed room stops advertising a way out and
 * a room which lost its only opening to the core does too. Terrain is the only thing touched: no
 * object inside any of these rooms is read, moved or deleted.
 *
 * @returns The names of every room which was written to.
 */
export function wallSectorCores<Record extends TerrainEntry>(terrain: Map<string, Record>, core: Iterable<string>): string[] {
	const coreSet = new Set(core);
	const touched = new Set<string>();
	for (const name of coreSet) {
		const record = terrain.get(name);
		if (record === undefined) {
			continue;
		}
		solid(record.terrain);
		record.exits = packExits(record.terrain);
		touched.add(name);

		const { rx, ry } = parseSignedRoomName(name);
		for (const [ dx, dy ] of neighbors) {
			const neighborName = makeSignedRoomName(rx + dx, ry + dy);
			if (coreSet.has(neighborName)) {
				// The two cores share an edge and are both solid already.
				continue;
			}
			const neighbor = terrain.get(neighborName);
			if (neighbor === undefined) {
				continue;
			}
			const writer = new TerrainWriter(getBuffer(neighbor.terrain));
			if (dx === 0) {
				// Neighbour above or below: wall the row of it which faces the core.
				const yy = dy < 0 ? 49 : 0;
				for (let xx = 0; xx < 50; ++xx) {
					writer.set(xx, yy, TERRAIN_MASK_WALL);
				}
			} else {
				const xx = dx < 0 ? 49 : 0;
				for (let yy = 0; yy < 50; ++yy) {
					writer.set(xx, yy, TERRAIN_MASK_WALL);
				}
			}
			neighbor.exits = packExits(neighbor.terrain);
			touched.add(neighborName);
		}
	}
	return [ ...touched ];
}

/**
 * Whether every room in `core` already reads as solid, i.e. this has run against this world before.
 * Derived from the terrain rather than from a stored flag, so lifting the wall by writing a backup
 * back also undoes this state and the next service start paints it again.
 */
export function isSolid<Record extends TerrainEntry>(terrain: ReadonlyMap<string, Record>, core: Iterable<string>): boolean {
	let sawRoom = false;
	for (const name of core) {
		const record = terrain.get(name);
		if (record === undefined) {
			continue;
		}
		sawRoom = true;
		if (record.exits !== 0 || record.terrain.get(25, 25) !== TERRAIN_MASK_WALL) {
			return false;
		}
	}
	return sawRoom;
}
