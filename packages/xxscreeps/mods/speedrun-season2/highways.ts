import type { Terrain } from 'xxscreeps/game/terrain.js';
import { TERRAIN_MASK_WALL, TerrainWriter, getBuffer, packExits } from 'xxscreeps/game/terrain.js';
import { isSeason2Room } from './rooms.js';

interface TerrainEntry {
	exits: number;
	terrain: Terrain;
}

export interface HighwayFace {
	room: string;
	side: 'top' | 'right' | 'bottom' | 'left';
	highway: string;
}

/** Only the season-2 side of a closed highway is painted, never the highway itself. */
export function closedHighwayFaces(name: string, openRooms: ReadonlySet<string>): HighwayFace[] {
	if (!isSeason2Room(name)) {
		return [];
	}
	const xx = Number(name[1]);
	const yy = Number(name[3]);
	const faces: HighwayFace[] = [];
	const add = (side: HighwayFace['side'], highway: string) => {
		if (!openRooms.has(highway)) {
			faces.push({ room: name, side, highway });
		}
	};
	if (yy === 9) { add('top', `E${xx}N10`); }
	if (xx === 9) { add('right', `E10N${yy}`); }
	if (yy === 1) { add('bottom', `E${xx}N0`); }
	if (xx === 1) { add('left', `E0N${yy}`); }
	return faces;
}

/** Copy on write: a preview must not mutate the World reader's backing terrain blob. */
export function planHighwaySealing<Record extends TerrainEntry>(terrain: ReadonlyMap<string, Record>, openRooms: ReadonlySet<string>) {
	const faces: HighwayFace[] = [];
	const changes = new Map<string, Record>();
	for (const [ name, record ] of terrain) {
		const roomFaces = closedHighwayFaces(name, openRooms);
		if (roomFaces.length === 0) {
			continue;
		}
		faces.push(...roomFaces);
		const tiles = new TerrainWriter(Uint8Array.from(getBuffer(record.terrain)));
		for (const { side } of roomFaces) {
			for (let ii = 0; ii < 50; ++ii) {
				switch (side) {
					case 'top': tiles.set(ii, 0, TERRAIN_MASK_WALL); break;
					case 'right': tiles.set(49, ii, TERRAIN_MASK_WALL); break;
					case 'bottom': tiles.set(ii, 49, TERRAIN_MASK_WALL); break;
					case 'left': tiles.set(0, ii, TERRAIN_MASK_WALL); break;
				}
			}
		}
		const exits = packExits(tiles);
		if (record.exits !== exits || getBuffer(tiles).some((value, index) => value !== getBuffer(record.terrain)[index])) {
			changes.set(name, { ...record, terrain: tiles, exits });
		}
	}
	return { faces, changes };
}
