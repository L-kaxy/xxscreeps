import type { Terrain } from 'xxscreeps/game/terrain.js';
import type { SectorControl } from 'xxscreeps/mods/modern/sector/schema.js';
import { makeSignedRoomName, parseSignedRoomName } from 'xxscreeps/game/room/name.js';
import { TERRAIN_MASK_SWAMP, TERRAIN_MASK_WALL, getBuffer, isBorder, packExits } from 'xxscreeps/game/terrain.js';

/**
 * One room template, stamped over every room of a sector's interior.
 *
 * The terrain is generated the way `scripts/room-gen.ts` generates a room -- the same wall layouts
 * (1-28), the same swamp layouts (0-14), the same cellular-automaton fill and smoothing -- with two
 * changes which make a single room reusable across a map:
 *
 *   - the exits do not come from the neighbours. Every side is opened with the same centred run, so
 *     the top opening is exactly the bottom one and the left exactly the right. Two rooms built from
 *     the template share a border tile for tile, which is what walks the whole grid through, and no
 *     room can advertise an exit the room across from it seals.
 *   - a layout the generator would have rerolled is repaired instead. `room-gen` rolls a fresh grid
 *     until every open tile is connected (`checkFlood`); a template has to converge on the layout the
 *     operator picked, so a grid which comes out split has its exit throats carved into the main
 *     region and its stray pockets walled off -- the repair the deterministic highway path of
 *     `room-gen` already uses.
 *
 * Terrain is the only thing written. A room keeps whatever sources, minerals and controllers it has,
 * wherever they are -- which is why the caller reports the ones a wall landed on rather than moving
 * them: only the operator can decide what to do about those.
 */

interface TerrainTypeParams {
	fill: number;
	smooth: number;
	factor: number;
}

// Layout parameters, verbatim from `scripts/room-gen.ts`.
const wallTypes: Record<number, TerrainTypeParams> = {
	1: { fill: 0.4, smooth: 10, factor: 5 },
	2: { fill: 0.2, smooth: 20, factor: 4 },
	3: { fill: 0.2, smooth: 20, factor: 4 },
	4: { fill: 0.3, smooth: 18, factor: 4 },
	5: { fill: 0.3, smooth: 10, factor: 4 },
	6: { fill: 0.3, smooth: 10, factor: 4 },
	7: { fill: 0.3, smooth: 10, factor: 4 },
	8: { fill: 0.35, smooth: 15, factor: 4 },
	9: { fill: 0.3, smooth: 2, factor: 4 },
	10: { fill: 0.35, smooth: 2, factor: 4 },
	11: { fill: 0.35, smooth: 5, factor: 4 },
	12: { fill: 0.35, smooth: 5, factor: 4 },
	13: { fill: 0.25, smooth: 5, factor: 4 },
	14: { fill: 0.4, smooth: 3, factor: 5 },
	15: { fill: 0.5, smooth: 3, factor: 5 },
	16: { fill: 0.45, smooth: 4, factor: 5 },
	17: { fill: 0.45, smooth: 6, factor: 5 },
	18: { fill: 0.45, smooth: 10, factor: 5 },
	19: { fill: 0.5, smooth: 10, factor: 5 },
	20: { fill: 0.4, smooth: 3, factor: 5 },
	21: { fill: 0.5, smooth: 2, factor: 5 },
	22: { fill: 0.45, smooth: 4, factor: 5 },
	23: { fill: 0.45, smooth: 6, factor: 5 },
	24: { fill: 0.45, smooth: 10, factor: 5 },
	25: { fill: 0.5, smooth: 10, factor: 5 },
	26: { fill: 0.45, smooth: 10, factor: 5 },
	27: { fill: 0.45, smooth: 6, factor: 5 },
	28: { fill: 0.2, smooth: 20, factor: 4 },
};

const swampTypes: Record<number, TerrainTypeParams> = {
	1: { fill: 0.3, smooth: 3, factor: 5 },
	2: { fill: 0.35, smooth: 3, factor: 5 },
	3: { fill: 0.45, smooth: 3, factor: 5 },
	4: { fill: 0.25, smooth: 1, factor: 5 },
	5: { fill: 0.25, smooth: 30, factor: 4 },
	6: { fill: 0.52, smooth: 30, factor: 5 },
	7: { fill: 0.45, smooth: 3, factor: 5 },
	8: { fill: 0.3, smooth: 1, factor: 5 },
	9: { fill: 0.3, smooth: 1, factor: 4 },
	10: { fill: 0.3, smooth: 3, factor: 5 },
	11: { fill: 0.3, smooth: 3, factor: 5 },
	12: { fill: 0.3, smooth: 1, factor: 5 },
	13: { fill: 0.25, smooth: 1, factor: 5 },
	14: { fill: 0.35, smooth: 3, factor: 5 },
};

export const kMaxTerrainType = 28;
export const kMaxSwampType = 14;

/** Wall layouts 1-28: `terrain-type` on the `generate-room` command line. */
export function isWallType(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= kMaxTerrainType;
}

/** Swamp layouts 1-14, or 0 for no swamp at all: `swamp-type` on the `generate-room` command line. */
export function isSwampType(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= kMaxSwampType;
}

interface Cell {
	wall: boolean;
	swamp: boolean;
	forceOpen: boolean;
}

type Grid = Cell[][];

const kGridSize = 50;
const kTiles = kGridSize * kGridSize;

function *iterateInRange(cxx: number, cyy: number, range: number) {
	for (let nyy = cyy - range; nyy <= cyy + range; ++nyy) {
		if (nyy < 0 || nyy >= kGridSize) {
			continue;
		}
		for (let nxx = cxx - range; nxx <= cxx + range; ++nxx) {
			if (nxx < 0 || nxx >= kGridSize) {
				continue;
			}
			yield [ nxx, nyy ] as const;
		}
	}
}

function makeGrid(): Grid {
	return Array.from({ length: kGridSize }, () =>
		Array.from({ length: kGridSize }, (): Cell => ({ wall: false, swamp: false, forceOpen: false })));
}

function smooth(grid: Grid, factor: number, key: 'wall' | 'swamp'): Grid {
	const next = makeGrid();
	for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			const nextCell = next[yy]![xx]!;
			Object.assign(nextCell, cell);
			let count = 0;
			for (let dyy = -1; dyy <= 1; ++dyy) {
				for (let dxx = -1; dxx <= 1; ++dxx) {
					const nxx = xx + dxx;
					const nyy = yy + dyy;
					const outOfBounds = nxx < 0 || nyy < 0 || nxx >= kGridSize || nyy >= kGridSize;
					if (outOfBounds) {
						// The world outside the room counts as wall, so the border band stays sealed.
						if (key === 'wall') {
							count++;
						}
					} else if (grid[nyy]![nxx]![key]) {
						count++;
					}
				}
			}
			nextCell[key] = count >= factor;
			if (key === 'wall') {
				if (isBorder(xx, yy)) {
					nextCell.wall = true;
				}
				// The exit tiles, and the tiles inboard of them, stay open through every pass.
				if (cell.forceOpen) {
					nextCell.wall = false;
				}
			}
		}
	}
	return next;
}

/** Whether every open tile of the room is in one region -- 8-connected, as a creep walks. */
function isConnected(grid: Grid): boolean {
	let startXx = -1;
	let startYy = -1;
	outer: for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			if (!cell.wall) {
				startXx = xx;
				startYy = yy;
				break outer;
			}
		}
	}
	if (startXx === -1) {
		return false;
	}
	const visited = Array.from({ length: kGridSize }, () => new Array<boolean>(kGridSize).fill(false));
	const stack: [ number, number ][] = [ [ startXx, startYy ] ];
	visited[startYy]![startXx] = true;
	while (stack.length > 0) {
		const [ cxx, cyy ] = stack.pop()!;
		for (const [ nxx, nyy ] of iterateInRange(cxx, cyy, 1)) {
			if (!grid[nyy]![nxx]!.wall && !visited[nyy]![nxx]) {
				visited[nyy]![nxx] = true;
				stack.push([ nxx, nyy ]);
			}
		}
	}
	for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			if (!cell.wall && !visited[yy]![xx]) {
				return false;
			}
		}
	}
	return true;
}

export interface ExitMap {
	top: number[];
	right: number[];
	bottom: number[];
	left: number[];
}

/**
 * The one opening every side of the template carries: `width` tiles wide and centred, which makes it
 * symmetric about both axes. The same positions on all four sides is what lines two rooms up across
 * a border.
 */
export function templateExits(width: number): ExitMap {
	const start = Math.floor((kGridSize - width) / 2);
	const run = Array.from({ length: width }, (_, ii) => start + ii);
	return { top: run, right: run, bottom: run, left: run };
}

/** Marks the exit tiles, and the tiles inboard of them, open through generation. */
function markExits(grid: Grid, exits: ExitMap) {
	for (const xx of exits.top) {
		grid[0]![xx]!.forceOpen = true;
		grid[1]![xx]!.forceOpen = true;
	}
	for (const xx of exits.bottom) {
		grid[49]![xx]!.forceOpen = true;
		grid[48]![xx]!.forceOpen = true;
	}
	for (const yy of exits.left) {
		grid[yy]![0]!.forceOpen = true;
		grid[yy]![1]!.forceOpen = true;
	}
	for (const yy of exits.right) {
		grid[yy]![49]!.forceOpen = true;
		grid[yy]![48]!.forceOpen = true;
	}
}

function fillGrid(exits: ExitMap, wallType: number, swampType: number): Grid {
	const grid = makeGrid();
	markExits(grid, exits);
	for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			if (cell.forceOpen && isBorder(xx, yy)) {
				continue;
			}
			cell.wall = Math.random() < wallTypes[wallType]!.fill;
			cell.swamp = swampType ? Math.random() < swampTypes[swampType]!.fill : false;
		}
	}
	const params = wallTypes[wallType]!;
	let smoothed = grid;
	for (let ii = 0; ii < params.smooth; ++ii) {
		smoothed = smooth(smoothed, params.factor, 'wall');
	}
	return smoothed;
}

function smoothSwamp(grid: Grid, swampType: number): Grid {
	if (!swampType) {
		return grid;
	}
	const params = swampTypes[swampType]!;
	let smoothed = grid;
	for (let ii = 0; ii < params.smooth; ++ii) {
		smoothed = smooth(smoothed, params.factor, 'swamp');
	}
	return smoothed;
}

const kOrthogonal = [ [ 0, -1 ], [ 0, 1 ], [ -1, 0 ], [ 1, 0 ] ] as const;

/** Open tiles reachable from (xx, yy), as a set of packed `yy * 50 + xx` keys. */
function reachableOpen(grid: Grid, xx: number, yy: number): Set<number> {
	const reached = new Set([ yy * kGridSize + xx ]);
	const stack: [ number, number ][] = [ [ xx, yy ] ];
	while (stack.length > 0) {
		const [ cxx, cyy ] = stack.pop()!;
		for (const [ dxx, dyy ] of kOrthogonal) {
			const nxx = cxx + dxx;
			const nyy = cyy + dyy;
			if (nxx >= 0 && nyy >= 0 && nxx < kGridSize && nyy < kGridSize &&
				!grid[nyy]![nxx]!.wall && !reached.has(nyy * kGridSize + nxx)) {
				reached.add(nyy * kGridSize + nxx);
				stack.push([ nxx, nyy ]);
			}
		}
	}
	return reached;
}

/** Breaches the thinnest seal between a cut-off exit throat and the open region. */
function carveToOpen(grid: Grid, sx: number, sy: number, reached: Set<number>): void {
	const start = sy * kGridSize + sx;
	const prev = new Map([ [ start, -1 ] ]);
	const queue: [ number, number ][] = [ [ sx, sy ] ];
	for (const [ cxx, cyy ] of queue) {
		const key = cyy * kGridSize + cxx;
		if (key !== start && reached.has(key)) {
			for (let step = key; step !== -1; step = prev.get(step) ?? -1) {
				const pxx = step % kGridSize;
				const pyy = (step - pxx) / kGridSize;
				// A border tile is never cleared: a path through a walled one would report the
				// throat connected while leaving it sealed.
				if (!isBorder(pxx, pyy)) {
					grid[pyy]![pxx]!.wall = false;
				}
				reached.add(step);
			}
			return;
		}
		for (const [ dxx, dyy ] of kOrthogonal) {
			const nxx = cxx + dxx;
			const nyy = cyy + dyy;
			if (nxx >= 0 && nyy >= 0 && nxx < kGridSize && nyy < kGridSize &&
				!(isBorder(nxx, nyy) && grid[nyy]![nxx]!.wall)) {
				const nkey = nyy * kGridSize + nxx;
				if (!prev.has(nkey)) {
					prev.set(nkey, key);
					queue.push([ nxx, nyy ]);
				}
			}
		}
	}
}

/** Carves every exit throat into the largest open region a throat sits in. */
function connectExits(grid: Grid, exits: ExitMap): void {
	const throats = [
		...exits.top.map(xx => [ xx, 1 ] as const),
		...exits.bottom.map(xx => [ xx, 48 ] as const),
		...exits.left.map(yy => [ 1, yy ] as const),
		...exits.right.map(yy => [ 48, yy ] as const),
	];
	const covered = new Set<number>();
	let reached: Set<number> | undefined;
	for (const [ xx, yy ] of throats) {
		if (!covered.has(yy * kGridSize + xx)) {
			const area = reachableOpen(grid, xx, yy);
			for (const key of area) {
				covered.add(key);
			}
			if (reached === undefined || area.size > reached.size) {
				reached = area;
			}
		}
	}
	if (reached === undefined) {
		return;
	}
	for (const [ bx, by ] of throats) {
		if (!reached.has(by * kGridSize + bx)) {
			carveToOpen(grid, bx, by, reached);
		}
	}
}

/** Walls off open ground the exits cannot reach, so a room has exactly one open region. */
function fillUnreachable(grid: Grid): void {
	const reached = new Set<number>();
	const stack: [ number, number ][] = [];
	for (let ii = 0; ii < kGridSize; ++ii) {
		for (const [ xx, yy ] of [ [ ii, 0 ], [ ii, 49 ], [ 0, ii ], [ 49, ii ] ] as const) {
			const key = yy * kGridSize + xx;
			if (!grid[yy]![xx]!.wall && !reached.has(key)) {
				reached.add(key);
				stack.push([ xx, yy ]);
			}
		}
	}
	// A room walled off on all four sides has no border to reach from; `fillGrid` keeps such a
	// room's ground for the same reason.
	if (stack.length === 0) {
		return;
	}
	while (stack.length > 0) {
		const [ cxx, cyy ] = stack.pop()!;
		for (const [ nxx, nyy ] of iterateInRange(cxx, cyy, 1)) {
			const key = nyy * kGridSize + nxx;
			if (!grid[nyy]![nxx]!.wall && !reached.has(key)) {
				reached.add(key);
				stack.push([ nxx, nyy ]);
			}
		}
	}
	for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			cell.wall ||= !reached.has(yy * kGridSize + xx);
		}
	}
}

function gridToTerrain(grid: Grid): Uint8Array {
	const buffer = new Uint8Array(625);
	const set = (xx: number, yy: number, value: number) => {
		const index = yy * kGridSize + xx;
		const byte = index >>> 2;
		const shift = (index & 0x03) << 1;
		buffer[byte] = (buffer[byte]! & ~(0x03 << shift)) | ((value & 0x03) << shift);
	};
	for (const [ yy, row ] of grid.entries()) {
		for (const [ xx, cell ] of row.entries()) {
			if (cell.wall) {
				set(xx, yy, TERRAIN_MASK_WALL);
			} else if (cell.swamp) {
				// Swamp with no plain neighbour is dropped, the way `room-gen` packs a room.
				let hasNonWall = false;
				for (const [ nxx, nyy ] of iterateInRange(xx, yy, 1)) {
					if (!grid[nyy]![nxx]!.wall) {
						hasNonWall = true;
						break;
					}
				}
				if (hasNonWall) {
					set(xx, yy, TERRAIN_MASK_SWAMP);
				}
			}
		}
	}
	return buffer;
}

export interface TemplateSpec {
	/** Wall layout, 1-28. */
	terrainType: number;
	/** Swamp layout, 0-14; 0 is no swamp. */
	swampType: number;
	/** Width in tiles of the opening every side carries. */
	exitWidth: number;
}

/**
 * How many grids generation rolls before it repairs one instead. `room-gen` rerolls the wall layout
 * at this count, which would ignore the layout the operator picked; a template repairs the grid and
 * keeps it.
 */
const kFillAttempts = 100;

/** Builds the room every covered room will be made of, as the packed 625-byte terrain. */
export function generateTemplate(spec: TemplateSpec) {
	const exits = templateExits(spec.exitWidth);
	let grid: Grid | undefined;
	let repaired = false;
	let attempts = 0;
	for (; attempts < kFillAttempts; ++attempts) {
		const attempt = fillGrid(exits, spec.terrainType, spec.swampType);
		if (isConnected(attempt)) {
			grid = attempt;
			break;
		}
	}
	if (grid === undefined) {
		// The layout leaves the room in pieces: carve the exits into the main region and wall off
		// what is left over, so the room connects whatever layout was asked for.
		grid = fillGrid(exits, spec.terrainType, spec.swampType);
		connectExits(grid, exits);
		fillUnreachable(grid);
		repaired = true;
	}
	grid = smoothSwamp(grid, spec.swampType);
	return { terrain: gridToTerrain(grid), repaired, attempts };
}

/** The width of the opening the template's top border carries, read back off the terrain. */
export function templateExitWidth(template: Readonly<Uint8Array>): number {
	let length = 0;
	for (let xx = 1; xx < kGridSize - 1; ++xx) {
		const index = xx;
		if (((template[index >>> 2]! >>> ((index & 0x03) << 1)) & 0x03) !== TERRAIN_MASK_WALL) {
			length++;
		}
	}
	return length;
}

// --- applying the template to a world ---------------------------------------

/**
 * The fields of a `World.terrain` entry this module reads and rewrites. Everything else on the
 * record -- `sectors` and the `sectorControl` a sector's resource placement hangs off -- is left
 * alone, which is what keeps deposit and power bank placement working.
 */
export interface TerrainEntry {
	exits: number;
	terrain: Terrain;
}

export interface UniformLayout {
	/** Sector cores: solid, and never covered by the template. */
	core: string[];
	/** The interiors the template covers: each sector's 9x9 `members`, minus the cores. */
	rooms: string[];
	/** The highway ring around them, `edges`, only ever opened on the face which looks inward. */
	ring: string[];
}

/** The four neighbours of a room, as signed coordinate offsets, with the edge they share. */
const kNeighbors = [
	{ dx: 0, dy: -1, row: 0, column: -1 },
	{ dx: 0, dy: 1, row: 49, column: -1 },
	{ dx: 1, dy: 0, row: -1, column: 49 },
	{ dx: -1, dy: 0, row: -1, column: 0 },
] as const;

/** The row or column of ours which faces offset (dx, dy), as `[ xx, yy ]` pairs. */
function edgeTiles(edge: { row: number; column: number }): [ number, number ][] {
	const tiles: [ number, number ][] = [];
	for (let ii = 0; ii < kGridSize; ++ii) {
		tiles.push(edge.column === -1 ? [ ii, edge.row ] : [ edge.column, ii ]);
	}
	return tiles;
}

/**
 * Splits the world's rooms into the cores, the interiors a template covers, and the ring. Reads the
 * geometry out of the world's own sector records -- `sectorControl.members` is each sector's 9x9
 * interior and `.edges` its highway ring -- so a world of several sectors needs no further
 * configuration.
 */
export function uniformLayout<Record extends { sectorControl?: SectorControl | undefined }>(
	terrain: ReadonlyMap<string, Record>,
	core: Iterable<string>,
): UniformLayout {
	const coreSet = new Set([ ...core ].filter(name => terrain.has(name)));
	const rooms = new Set<string>();
	const ring = new Set<string>();
	for (const { sectorControl } of terrain.values()) {
		if (sectorControl === undefined) {
			continue;
		}
		for (const member of sectorControl.members) {
			if (terrain.has(member)) {
				rooms.add(member);
			}
		}
		for (const edge of sectorControl.edges) {
			if (terrain.has(edge)) {
				ring.add(edge);
			}
		}
	}
	for (const name of coreSet) {
		rooms.delete(name);
	}
	for (const name of rooms) {
		ring.delete(name);
	}
	return { core: [ ...coreSet ], rooms: [ ...rooms ], ring: [ ...ring ] };
}

function paint(buffer: Uint8Array, xx: number, yy: number, value: number) {
	const index = yy * kGridSize + xx;
	const byte = index >>> 2;
	const shift = (index & 0x03) << 1;
	buffer[byte] = (buffer[byte]! & ~(0x03 << shift)) | ((value & 0x03) << shift);
}

/**
 * The terrain a covered room is expected to hold: the template, with the edge it shares with a core
 * room painted solid. `wallSectorCores` walls those edges so a creep cannot be handed into the
 * solid core from the room it is leaving; a room which shut its core face keeps the template
 * everywhere else.
 */
function expectedTerrain(template: Readonly<Uint8Array>, name: string, core: ReadonlySet<string>) {
	const buffer = Uint8Array.from(template);
	if (core.size !== 0) {
		const { rx, ry } = parseSignedRoomName(name);
		for (const neighbor of kNeighbors) {
			if (core.has(makeSignedRoomName(rx + neighbor.dx, ry + neighbor.dy))) {
				for (const [ xx, yy ] of edgeTiles(neighbor)) {
					paint(buffer, xx, yy, TERRAIN_MASK_WALL);
				}
			}
		}
	}
	return buffer;
}

/**
 * The tiles of the highway ring which have to be opened so a covered room connects outward, by ring
 * room. The face which looks at a covered room carries the template's opening; the rest of the ring
 * is left exactly as it is, so its own lane ends survive.
 */
function ringOpeningTiles(rooms: readonly string[], ring: ReadonlySet<string>, exits: ExitMap): Map<string, number[]> {
	const opening = new Map<string, number[]>();
	for (const name of rooms) {
		const { rx, ry } = parseSignedRoomName(name);
		for (const neighbor of kNeighbors) {
			const neighborName = makeSignedRoomName(rx + neighbor.dx, ry + neighbor.dy);
			if (!ring.has(neighborName)) {
				continue;
			}
			let tiles = opening.get(neighborName);
			if (tiles === undefined) {
				opening.set(neighborName, tiles = []);
			}
			// The face of the neighbour which touches us, mirroring `kNeighbors`: the room to our
			// north keeps its row 49 on the shared border, the one to our west its column 49.
			const run = neighbor.dx === 0 ? exits.top : exits.left;
			for (const ii of run) {
				tiles.push(neighbor.dx === 0
					? (neighbor.dy < 0 ? 49 : 0) * kGridSize + ii
					: ii * kGridSize + (neighbor.dx < 0 ? 49 : 0));
			}
		}
	}
	return opening;
}

function sameBytes(left: Readonly<Uint8Array>, right: Readonly<Uint8Array>) {
	for (let ii = 0; ii < left.length; ++ii) {
		if (left[ii] !== right[ii]) {
			return false;
		}
	}
	return true;
}

/** Whether the world already holds this template: every covered room equals what it should -- the
 * template, plus the core face it has to keep shut -- and every ring face which looks at one of them
 * carries its opening. Read out of the terrain rather than kept in a stored flag, the way `walls.ts`
 * reads a solid core out of its own.
 */
export function isUniform<Record extends TerrainEntry>(
	terrain: ReadonlyMap<string, Record>,
	template: Readonly<Uint8Array>,
	layout: UniformLayout,
	options: { ringEdges: boolean; sealCore: boolean },
): boolean {
	const core = options.sealCore ? new Set(layout.core) : new Set<string>();
	let sawRoom = false;
	for (const name of layout.rooms) {
		const record = terrain.get(name);
		if (record === undefined) {
			continue;
		}
		sawRoom = true;
		if (!sameBytes(getBuffer(record.terrain), expectedTerrain(template, name, core))) {
			return false;
		}
	}
	if (!options.ringEdges) {
		return sawRoom;
	}
	const opening = ringOpeningTiles(layout.rooms, new Set(layout.ring), templateExits(templateExitWidth(template)));
	for (const [ name, tiles ] of opening) {
		const record = terrain.get(name);
		if (record === undefined) {
			continue;
		}
		const buffer = getBuffer(record.terrain);
		for (const index of tiles) {
			if (((buffer[index >>> 2]! >>> ((index & 0x03) << 1)) & 0x03) === TERRAIN_MASK_WALL) {
				return false;
			}
		}
	}
	return sawRoom;
}

/**
 * Stamps the template over every covered room, keeps the core faces which have to stay shut shut,
 * and opens the highway ring's inward faces so the outermost rooms really connect. Terrain and the
 * `exits` bitfield are the only things written: no room blob is rewritten and no object is read,
 * moved or deleted.
 *
 * @returns Every room which was written to.
 */
export function applyUniform<Record extends TerrainEntry>(
	terrain: Map<string, Record>,
	template: Readonly<Uint8Array>,
	layout: UniformLayout,
	options: { ringEdges: boolean; sealCore: boolean },
): string[] {
	const core = options.sealCore ? new Set(layout.core) : new Set<string>();
	const touched = new Set<string>();
	for (const name of layout.rooms) {
		const record = terrain.get(name);
		if (record === undefined) {
			continue;
		}
		getBuffer(record.terrain).set(expectedTerrain(template, name, core));
		record.exits = packExits(record.terrain);
		touched.add(name);
	}
	if (options.ringEdges) {
		const opening = ringOpeningTiles(layout.rooms, new Set(layout.ring), templateExits(templateExitWidth(template)));
		for (const [ name, tiles ] of opening) {
			const record = terrain.get(name);
			if (record === undefined) {
				continue;
			}
			const buffer = getBuffer(record.terrain);
			for (const index of tiles) {
				const xx = index % kGridSize;
				const yy = (index - xx) / kGridSize;
				paint(buffer, xx, yy, 0);
			}
			record.exits = packExits(record.terrain);
			touched.add(name);
		}
	}
	return [ ...touched ];
}

/**
 * The terrain a covered room holds once the template is applied: the template, plus the face the
 * room has to keep shut when it looks at a core.
 */
export function coveredTerrain(template: Readonly<Uint8Array>, name: string, core: Iterable<string>): Uint8Array {
	return expectedTerrain(template, name, new Set(core));
}

/**
 * Whether a creep could stand next to (xx, yy). A covered room's plain tiles are one region, so any
 * plain neighbour is a spot a creep can reach the object from; the tile under the object itself is
 * not walkable in this engine either way.
 */
export function hasStandingRoom(template: Readonly<Uint8Array>, xx: number, yy: number): boolean {
	for (const [ nxx, nyy ] of iterateInRange(xx, yy, 1)) {
		if (nxx !== xx || nyy !== yy) {
			const index = nyy * kGridSize + nxx;
			if (((template[index >>> 2]! >>> ((index & 0x03) << 1)) & 0x03) !== TERRAIN_MASK_WALL) {
				return true;
			}
		}
	}
	return false;
}
