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
 * each sector.
 *
 * The world already carries that geometry: `sectorControl` is stamped on every center room when the
 * world is built (`mods/modern/sector/schema.ts`, via `computeRoomMeta`), with `members` the 9x9
 * interior at range <= 4 (the center among them) and `edges` the highway ring at range 5. So the
 * core is read out of the world rather than derived from room names: any name-based rule has to
 * re-derive `parseSignedRoomName`'s W/N convention (`W5` is -6, not -5, per `game/room/name.ts:59`),
 * and getting it wrong shifts the whole 3x3 one room diagonally.
 *
 * Only rooms in `open` are ever returned, so this can drop rooms from the world but never invent one.
 */
export function roomsToClose(terrain: WorldTerrain, open: Iterable<string>): string[] {
	const openSet = new Set(open);
	const closing = new Set<string>();
	let sawSectorRecord = false;
	for (const [ center, { sectorControl } ] of terrain) {
		if (sectorControl === undefined) {
			continue;
		}
		sawSectorRecord = true;
		const { rx, ry } = parseSignedRoomName(center);
		for (let dx = -1; dx <= 1; ++dx) {
			for (let dy = -1; dy <= 1; ++dy) {
				const core = makeSignedRoomName(rx + dx, ry + dy);
				if (openSet.has(core)) {
					closing.add(core);
				}
			}
		}
	}
	// A world with no sector records at all -- a hand-built test fixture, or a shard imported without
	// the sector mod -- has no geometry to read, so fall back to the classifier the generator itself
	// uses to lay a sector out.
	return sawSectorRecord ? [ ...closing ] : classifyByRoomType(open);
}

function classifyByRoomType(open: Iterable<string>): string[] {
	return [ ...open ].filter(name => {
		const type = roomType(name);
		return type === 'center' || type === 'sourceKeeper';
	});
}
