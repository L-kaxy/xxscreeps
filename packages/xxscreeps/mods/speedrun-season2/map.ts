import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import * as RoomSchema from 'xxscreeps/engine/db/room.js';
import { World, schema as worldSchema } from 'xxscreeps/game/map.js';
import { StructureController } from 'xxscreeps/mods/classic/controller/controller.js';
import { Creep } from 'xxscreeps/mods/classic/creep/creep.js';
import { StructureExtractor } from 'xxscreeps/mods/classic/mineral/extractor.js';
import { Mineral } from 'xxscreeps/mods/classic/mineral/mineral.js';
import { StructureKeeperLair } from 'xxscreeps/mods/classic/source/keeper-lair.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { planHighwaySealing } from './highways.js';
import { buildSeason2Map, originalMap, season2MapRooms, translateOriginalRoom } from './original-map.js';

export const mapStateKey = 'speedrun-season2/mapState';
export const mapTerrainBackupKey = 'speedrun-season2/mapBackup/terrain';
export const mapOpenRoomsBackupKey = 'speedrun-season2/mapBackup/openRooms';
export const highwayTerrainBackupKey = 'speedrun-season2/mapBackup/beforeHighwaySealing';

export interface HighwayReport {
	state: 'preview' | 'sealed';
	written: boolean;
	rooms: number;
	edges: number;
	faces: ReturnType<typeof planHighwaySealing>['faces'];
	changedRooms: string[];
}

interface MapState {
	format: 1;
	state: 'prepared' | 'complete' | 'restored';
	sourceSha256: string;
	tick: number;
	objectIds: string[];
}

export interface MapReport {
	state: 'ready' | 'conflict' | MapState['state'];
	written: boolean;
	rooms: number;
	objects: number;
	source: typeof originalMap.source;
	mapping: { from: string; to: string }[];
	conflicts: string[];
}

async function readState(shard: Shard) {
	const stored = await shard.data.get(mapStateKey);
	if (stored === null) {
		return undefined;
	}
	const state = JSON.parse(stored) as Partial<MapState>;
	if (state.format !== 1 || state.state === undefined || ![ 'prepared', 'complete', 'restored' ].includes(state.state)
		|| !Array.isArray(state.objectIds) || state.sourceSha256 !== originalMap.source.sha256
		|| !Number.isInteger(state.tick)) {
		throw new Error('Unrecognized season-2 map journal; do not overwrite it');
	}
	return state as MapState;
}

async function readMap(shard: Shard) {
	const [ blob, open ] = await Promise.all([
		shard.data.req('terrain', { blob: true }), shard.data.sMembers('rooms'),
	]);
	// No upgrader write-back in a preview; step 3 uses the unchanged current world schema.
	return { blob, open, world: new World(shard.name, blob, new Set(open)) };
}

async function reportFor(shard: Shard) {
	const [ state, { world, open } ] = await Promise.all([ readState(shard), readMap(shard) ]);
	const conflicts: string[] = [];
	if (state?.state !== 'complete' && state?.state !== 'prepared') {
		for (const name of season2MapRooms) {
			const slots = await Promise.all([ 0, 1 ].map(slot => shard.data.get(`room${slot}/${name}`, { blob: true })));
			if (world.terrain.has(name) || open.includes(name) || slots.some(blob => blob !== null)) {
				conflicts.push(name);
			}
		}
	}
	let status: MapReport['state'] = conflicts.length === 0 ? 'ready' : 'conflict';
	if (state?.state === 'complete' || state?.state === 'prepared') {
		status = state.state;
	}
	const report: MapReport = {
		state: status,
		written: false,
		rooms: season2MapRooms.length,
		objects: Object.values(originalMap.rooms).reduce((sum, room) => sum + room.objects.length, 0),
		source: originalMap.source,
		mapping: Object.keys(originalMap.rooms).map(from => ({ from, to: translateOriginalRoom(from) })),
		conflicts,
	};
	return { report, state, world, open };
}

/** Read-only game-data preview; safe default for the CLI. */
export async function previewSeason2Map(shard: Shard): Promise<MapReport> {
	return (await reportFor(shard)).report;
}

async function requireStopped(shard: Shard, serverStopped: boolean) {
	if (!serverStopped) {
		throw new Error('Map writes require explicit --server-stopped acknowledgement');
	}
	if (await shard.data.get('mutex/main') !== null) {
		throw new Error('The shard main service is still running (or its lock has not expired); stop all services first');
	}
}

/** Offline, one-time addition. Existing target terrain or either room buffer is never overwritten. */
export async function initializeSeason2Map(shard: Shard, options: { serverStopped: boolean }): Promise<MapReport> {
	await requireStopped(shard, options.serverStopped);
	await using mutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using lock = await mutex.acquire();
	await requireStopped(shard, options.serverStopped);
	// Re-read all protection and merge inputs under the lock.
	const { report, state, world, open } = await reportFor(shard);
	if (state?.state === 'complete') {
		return report;
	}
	if (state?.state === 'prepared') {
		throw new Error('An incomplete map initialization exists; restore it before retrying');
	}
	if (report.conflicts.length !== 0) {
		throw new Error(`Season-2 target rooms already exist; refusing to overwrite: ${report.conflicts.join(' ')}`);
	}

	const occupiedIds = new Set<string>();
	for (const name of new Set([ ...world.terrain.keys(), ...open ])) {
		for (const slot of [ 0, 1 ]) {
			const blob = await shard.data.get(`room${slot}/${name}`, { blob: true });
			if (blob !== null) {
				const room = RoomSchema.read(await RoomSchema.upgrade(shard.db, blob));
				for (const object of room['#objects']) {
					occupiedIds.add(object.id);
				}
			}
		}
	}
	const added = buildSeason2Map(new Set(world.terrain.keys()), occupiedIds);
	// Raw terrain remains vendored unchanged; only faces towards closed exterior highways differ.
	for (const [ name, record ] of planHighwaySealing(added.terrain, new Set(open)).changes) {
		added.terrain.set(name, record);
	}
	const prepared: MapState = {
		format: 1, state: 'prepared', sourceSha256: originalMap.source.sha256,
		tick: Number(await shard.data.get('time')),
		objectIds: added.rooms.flatMap(room => room['#objects'].map(object => object.id)),
	};
	// Durable journal and old world snapshot BEFORE any map or room write. There is deliberately
	// no automatic retry from a startup hook or a half-finished command.
	await shard.data.set(mapTerrainBackupKey, Uint8Array.from(world.terrainBlob));
	await shard.data.set(mapOpenRoomsBackupKey, JSON.stringify(open));
	await shard.data.set(mapStateKey, JSON.stringify(prepared));
	await Promise.all([ shard.db.save(), shard.save() ]);

	for (const room of added.rooms) {
		const blob = RoomSchema.write(room);
		await shard.data.set(`room0/${room.name}`, blob);
		await shard.data.set(`room1/${room.name}`, blob);
	}
	for (const [ name, record ] of added.terrain) {
		world.terrain.set(name, record);
	}
	await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
	await shard.data.sAdd('rooms', season2MapRooms);
	await shard.data.set(mapStateKey, JSON.stringify({ ...prepared, state: 'complete' }));
	await Promise.all([ shard.db.save(), shard.save() ]);
	return { ...report, state: 'complete', written: true };
}

async function highwayPlan(shard: Shard) {
	const state = await readState(shard);
	if (state?.state !== 'complete') {
		throw new Error('Initialize and complete the season-2 map before sealing highway exits');
	}
	const { world, open } = await readMap(shard);
	if (season2MapRooms.some(name => !world.terrain.has(name))) {
		throw new Error('Season-2 terrain is incomplete; refusing partial highway sealing');
	}
	const plan = planHighwaySealing(world.terrain, new Set(open));
	const report: HighwayReport = {
		state: 'preview', written: false, rooms: new Set(plan.faces.map(face => face.room)).size,
		edges: plan.faces.length, faces: plan.faces, changedRooms: [ ...plan.changes.keys() ].sort(),
	};
	return { world, plan, report };
}

/** Read-only preview for an already initialized block, including maps from the previous version. */
export async function previewHighwaySealing(shard: Shard): Promise<HighwayReport> {
	return (await highwayPlan(shard)).report;
}

/** Explicit terrain-only retrofit: no room buffers, occupants, buildings, clock or race writes. */
export async function sealSeason2Highways(shard: Shard, options: { serverStopped: boolean }): Promise<HighwayReport> {
	await requireStopped(shard, options.serverStopped);
	await using mutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using lock = await mutex.acquire();
	await requireStopped(shard, options.serverStopped);
	const { world, plan, report } = await highwayPlan(shard);
	if (plan.changes.size === 0) {
		return { ...report, state: 'sealed' };
	}
	if (await shard.data.get(highwayTerrainBackupKey, { blob: true }) === null) {
		await shard.data.set(highwayTerrainBackupKey, Uint8Array.from(world.terrainBlob));
	}
	// Also a durability barrier on retry if a previous backup save failed in the same host.
	await shard.save();
	for (const [ name, record ] of plan.changes) {
		world.terrain.set(name, record);
	}
	await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
	await shard.save();
	return { ...report, state: 'sealed', written: true };
}

/**
 * Roll back this addition only, merging the CURRENT world rather than restoring the whole backup.
 * Player changes refuse rollback; naturally spawned keeper NPCs may be discarded with this block.
 * This is a map-initialization rollback, not season-2 respawn cleanup.
 */
export async function restoreSeason2Map(shard: Shard, options: { serverStopped: boolean }): Promise<MapReport> {
	await requireStopped(shard, options.serverStopped);
	await using mutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using lock = await mutex.acquire();
	await requireStopped(shard, options.serverStopped);
	const state = await readState(shard);
	const { report } = await reportFor(shard);
	if (state === undefined) {
		return { ...report, written: false };
	}
	if (state.state === 'restored') {
		return { ...report, state: 'restored', written: false };
	}
	await shard.data.req(mapTerrainBackupKey, { blob: true });
	const ids = new Set(state.objectIds);
	// Read and validate every buffer BEFORE deleting anything, including partial initialization.
	for (const name of season2MapRooms) {
		for (const slot of [ 0, 1 ]) {
			const blob = await shard.data.get(`room${slot}/${name}`, { blob: true });
			if (blob === null) {
				continue;
			}
			const room = RoomSchema.read(await RoomSchema.upgrade(shard.db, blob));
			if (room['#user'] != null || room['#level'] > 0 || room['#objects'].some(object => {
				if (object instanceof Creep && object['#user'] === '3') {
					return false;
				}
				return !ids.has(object.id) || !(object instanceof Source || object instanceof Mineral
					|| (object instanceof StructureController && object['#user'] === null)
					|| (object instanceof StructureKeeperLair && object['#user'] === '3')
					|| (object instanceof StructureExtractor && object['#user'] === null));
			})) {
				throw new Error(`Room ${name} has gameplay changes; refusing map rollback. Restore a full test-copy snapshot instead`);
			}
		}
	}
	// A failed restore remains recoverable on another explicit --restore invocation.
	await shard.data.set(mapStateKey, JSON.stringify({ ...state, state: 'prepared' }));
	await shard.save();
	const { world } = await readMap(shard);
	for (const name of season2MapRooms) {
		world.terrain.delete(name);
		// Local mDel only handles primitive keys, not blob-backed room buffers.
		await shard.data.del(`room0/${name}`);
		await shard.data.del(`room1/${name}`);
	}
	await shard.data.set('terrain', makeWriter(worldSchema)(world.terrain, true));
	await shard.data.sRem('rooms', season2MapRooms);
	await shard.data.set(mapStateKey, JSON.stringify({ ...state, state: 'restored' }));
	await Promise.all([ shard.db.save(), shard.save() ]);
	return { ...report, state: 'restored', written: true };
}
