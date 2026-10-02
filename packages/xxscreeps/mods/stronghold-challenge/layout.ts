import type { SectorControl } from 'xxscreeps/mods/modern/sector/schema.js';
import { makeSignedRoomName, parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { TERRAIN_MASK_WALL, TerrainWriter, packExits } from 'xxscreeps/game/terrain.js';

export interface ChallengePair {
	home: string;
	stronghold: string;
}

export interface ChallengeLayout {
	pairs: ChallengePair[];
	unused: string[];
}

export const kControllerPosition = { x: 10, y: 25 };
export const kStrongholdPosition = { x: 25, y: 25 };
export const kExitStart = 21;
export const kExitEnd = 28;

/** A complete 9x9 sector interior has four horizontal pairs per row and one unused column. */
export function challengeLayout(terrain: ReadonlyMap<string, { sectorControl?: SectorControl | undefined }>): ChallengeLayout {
	const sectors = [ ...terrain.values() ].flatMap(record => record.sectorControl === undefined ? [] : [ record.sectorControl ]);
	if (sectors.length !== 1) {
		throw new Error('Stronghold challenge requires exactly one complete 9x9 sector interior');
	}
	const members = new Set(sectors[0]!.members);
	const coordinates = [ ...members ].map(parseSignedRoomName);
	const left = Math.min(...coordinates.map(room => room.rx));
	const top = Math.min(...coordinates.map(room => room.ry));
	if (members.size !== 81 || coordinates.some(room => !Number.isInteger(room.rx) || !Number.isInteger(room.ry))) {
		throw new Error('Stronghold challenge requires 81 interior rooms');
	}
	const pairs: ChallengePair[] = [];
	const unused: string[] = [];
	for (let yy = 0; yy < 9; ++yy) {
		for (let xx = 0; xx < 9; ++xx) {
			const name = makeSignedRoomName(left + xx, top + yy);
			if (!members.has(name) || !terrain.has(name)) {
				throw new Error('Stronghold challenge interior must be a complete 9x9 square');
			}
			if (xx === 8) {
				unused.push(name);
			} else if (xx % 2 === 0) {
				pairs.push({ home: name, stronghold: makeSignedRoomName(left + xx + 1, top + yy) });
			}
		}
	}
	return { pairs, unused };
}

export function isChallengeHome(room: { name: string; '#challengePair'?: ChallengePair | undefined }) {
	return room['#challengePair']?.home === room.name;
}

/** Plain rooms have sealed borders; only the shared horizontal face of a pair is opened. */
export function challengeTerrain(name: string, pair?: ChallengePair) {
	const terrain = new TerrainWriter();
	for (let ii = 0; ii < 50; ++ii) {
		terrain.set(ii, 0, TERRAIN_MASK_WALL);
		terrain.set(ii, 49, TERRAIN_MASK_WALL);
		terrain.set(0, ii, TERRAIN_MASK_WALL);
		terrain.set(49, ii, TERRAIN_MASK_WALL);
	}
	if (pair !== undefined) {
		if (name !== pair.home && name !== pair.stronghold) {
			throw new Error('Room does not belong to its challenge pair');
		}
		const xx = name === pair.home ? 49 : 0;
		for (let yy = kExitStart; yy <= kExitEnd; ++yy) {
			terrain.set(xx, yy, 0);
		}
		if (name === pair.home) {
			terrain.set(kControllerPosition.x, kControllerPosition.y, TERRAIN_MASK_WALL);
		}
	}
	return { terrain, exits: packExits(terrain) };
}
