import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { ResourceType } from 'xxscreeps/mods/classic/resource/resource.js';
import type { ObjectPlan } from './template.js';
import { Mutex } from 'xxscreeps/engine/db/mutex.js';
import { schema as worldSchema } from 'xxscreeps/game/map.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { objectLosses, objectsMatch, placeObjects } from './place.js';
import { sectorCoreRooms } from './rooms.js';
import {
	applyUniform, coveredTerrain, generateTemplate, isUniform, kDefaultSources, kMaxSwampType, kMaxTerrainType,
	objectPlan, templateExitWidth, uniformLayout,
} from './template.js';

/**
 * One world for the whole interior, as the `uniform-terrain` command runs it.
 *
 * Every room of every sector's 9x9 interior -- everything but the core, 72 rooms of the stock world
 * -- is overwritten with one generated template, and given the same sources, mineral and controller
 * on the same tiles, so no room is a better start than another. The terrain is `generate-room`'s own
 * generator (`template.ts` has the layouts, the exits and the one repair it can make) and the object
 * placement is `room-gen`'s own rules (`place.ts` keeps them off ground a wall shut in); what this
 * module adds is the write.
 *
 * Two stores are written, under the game mutex so no tick runs in between:
 *
 *   - the terrain blob, once, with the world's terrain from before it put aside;
 *   - the room blob of every covered room whose objects changed, with its own before state put aside.
 *
 * `--restore` lifts both back. A room is only touched when its objects are not already the plan's,
 * and the plan is a function of the template, so a second run of the same template writes nothing.
 */

/** Where the terrain from before the first stamp is kept, the key `wallSectorCores` also uses. */
export const backupKey = 'speedrun/terrainBackup';

/** Where each covered room's before state is kept, one entry per double-buffer slot. */
export const roomBackupKey = 'speedrun/uniformRoomBackup';

export interface UniformRequest {
	/** Wall layout, 1-28; omitted rolls one, the way `generate-room` does. */
	terrainType?: number;
	/** Swamp layout, 0-14; omitted rolls one. 0 is no swamp. */
	swampType?: number;
	/** Width in tiles of the opening every side carries. Read back off a given template instead. */
	exitWidth?: number;
	/** A template to stamp instead of generating one: 625 packed bytes, the format the engine holds. */
	template?: Readonly<Uint8Array>;
	/** Whether the highway ring's inward faces are opened too. Default true. */
	ringEdges?: boolean;
	/** Whether the faces which look at a core are kept shut. Default true. */
	sealCore?: boolean;
	/** Whether every covered room is also given the plan's objects. Default true. */
	objects?: boolean;
	/** How many sources every covered room ends up with. Default 2. */
	sources?: number;
	/** When set, every covered room's mineral becomes this type. */
	mineral?: ResourceType | undefined;
	/** The plan to stamp; omitted plans one off the template. Only read when objects are placed. */
	plan?: ObjectPlan | undefined;
}

/** What one pass of the object plan did, summed over the covered rooms. */
export interface ObjectTally {
	moved: number;
	added: number;
	removed: number;
	nudged: number;
}

/** How many objects of each kind have no ground beside them to work from. */
export interface ObjectLosses {
	sources: number;
	minerals: number;
	controllers: number;
}

/** Rooms with sources, not one of them usable: the room cannot be harvested at all. */
export interface UniformReport {
	/** The terrain every covered room now holds, as the packed 625 bytes. */
	terrain: Uint8Array;
	terrainType: number;
	swampType: number;
	exitWidth: number;
	/** False when a template was passed in rather than generated. */
	generated: boolean;
	/** Whether the layout had to be repaired to connect its four exits. */
	repaired: boolean;
	attempts: number;
	covered: number;
	ringFaces: number;
	/** False for a dry run, and for a world which already held this template. */
	written: boolean;
	/** The plan stamped, or undefined when the run only wrote terrain. */
	plan: ObjectPlan | undefined;
	sources: number | undefined;
	mineral: ResourceType | undefined;
	/** Covered rooms whose objects were rewritten. */
	roomsWritten: number;
	objects: ObjectTally;
	/** Rooms where an object found its planned tile occupied and took the nearest free ground. */
	nudgedRooms: string[];
	/** Rooms where an object could not be given a tile at all. */
	blockedRooms: string[];
	/** Rooms which threw while being rewritten; the rest of the run carried on. */
	failedRooms: string[];
	/** What the rooms held before this pass, and what they hold after it. */
	lossesBefore: ObjectLosses;
	lossesAfter: ObjectLosses;
	/** Rooms which still have an object with no ground beside it. */
	flagged: string[];
}

/** The template to stamp: the one passed in, or a fresh one from the request's layout. */
export function buildTemplate(request: UniformRequest) {
	if (request.template !== undefined) {
		if (request.template.length !== 625) {
			throw new Error(`a template is 625 packed bytes, not ${request.template.length}`);
		}
		return {
			template: Uint8Array.from(request.template),
			terrainType: request.terrainType ?? 0,
			swampType: request.swampType ?? 0,
			repaired: false,
			attempts: 0,
			generated: false,
		};
	}
	// Omitted layouts roll, the way `generate-room` rolls what is not passed to it.
	const terrainType = request.terrainType ?? Math.floor(Math.random() * kMaxTerrainType) + 1;
	const swampType = request.swampType ?? Math.floor(Math.random() * kMaxSwampType);
	const { terrain, repaired, attempts } = generateTemplate({ terrainType, swampType, exitWidth: request.exitWidth ?? 8 });
	return { template: terrain, repaired, attempts, terrainType, swampType, generated: true };
}

/** Keeps a room's before state, both double-buffer slots, the first time it is rewritten. */
async function backupRoom(shard: Shard, name: string) {
	const slots = await Promise.all([ 0, 1 ].map(async slot => ({
		slot,
		blob: await shard.data.get(`room${slot}/${name}`, { blob: true }),
		saved: await shard.data.get(`${roomBackupKey}/${slot}/${name}`, { blob: true }),
	})));
	await Promise.all(slots
		.filter(slot => slot.blob !== null && slot.saved === null)
		.map(slot => shard.data.set(`${roomBackupKey}/${slot.slot}/${name}`, slot.blob!)));
}

function sumLosses(losses: readonly ObjectLosses[]): ObjectLosses {
	return {
		sources: losses.reduce((total, entry) => total + entry.sources, 0),
		minerals: losses.reduce((total, entry) => total + entry.minerals, 0),
		controllers: losses.reduce((total, entry) => total + entry.controllers, 0),
	};
}

/**
 * Stamps the interior with one template and gives every covered room the plan's objects. A dry run
 * reads everything and writes nothing -- the tallies are what a run would do; a world which already
 * holds the template and the plan writes nothing either.
 */
export async function applyUniformTerrain(
	shard: Shard,
	request: UniformRequest,
	options: { dryRun?: boolean } = {},
): Promise<UniformReport> {
	const world = await shard.loadWorld();
	const core = sectorCoreRooms(world.terrain);
	const layout = uniformLayout(world.terrain, core);
	if (layout.core.length === 0 || layout.rooms.length === 0) {
		throw new Error('this world has no sector records, so there is no interior to cover');
	}
	const sealing = {
		ringEdges: request.ringEdges !== false,
		sealCore: request.sealCore !== false,
	};
	const { template, repaired, attempts, generated, terrainType, swampType } = buildTemplate(request);
	const sources = request.objects === false ? undefined : request.sources ?? kDefaultSources;
	const plan = sources === undefined ? undefined : request.plan ?? objectPlan(template, sources);
	const place = sources === undefined || plan === undefined ? undefined : {
		sources,
		...request.mineral === undefined ? {} : { mineral: request.mineral },
	};
	const report: UniformReport = {
		terrain: template,
		terrainType,
		swampType,
		exitWidth: templateExitWidth(template),
		generated,
		repaired,
		attempts,
		covered: layout.rooms.length,
		ringFaces: 0,
		written: false,
		plan,
		sources,
		mineral: request.mineral,
		roomsWritten: 0,
		objects: { moved: 0, added: 0, removed: 0, nudged: 0 },
		nudgedRooms: [],
		blockedRooms: [],
		failedRooms: [],
		lossesBefore: { sources: 0, minerals: 0, controllers: 0 },
		lossesAfter: { sources: 0, minerals: 0, controllers: 0 },
		flagged: [],
	};

	// Reads only: no lock to take, nothing to write. The rooms are mutated in memory to measure what
	// a run would leave behind, which is the number that matters to an operator.
	if (options.dryRun) {
		const before: ObjectLosses[] = [];
		const after: ObjectLosses[] = [];
		for (const name of layout.rooms) {
			const room = await shard.loadRoom(name);
			const terrain = coveredTerrain(template, name, sealing.sealCore ? layout.core : []);
			before.push(objectLosses(room, terrain));
			if (plan !== undefined && place !== undefined) {
				placeObjects(room, plan, terrain, place);
			}
			after.push(objectLosses(room, terrain));
		}
		report.lossesBefore = sumLosses(before);
		report.lossesAfter = sumLosses(after);
		report.flagged = layout.rooms.filter((name, index) => {
			const losses = after[index]!;
			return losses.sources !== 0 || losses.minerals !== 0 || losses.controllers !== 0;
		});
		return report;
	}

	// Hold the game mutex so no tick runs while the terrain and the rooms are rewritten; a running
	// server releases it between ticks, and with no server it is uncontended. The same shape
	// `scripts/manage.ts` uses to write a room from outside the game loop.
	await using gameMutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using lock = await gameMutex.acquire();
	const time = Number(await shard.data.get('time'));
	if (!isUniform(world.terrain, template, layout, sealing)) {
		// Rollback material: the world's terrain as it is now, written once and never overwritten.
		// Taken as a copy, because the room records read out of the blob may write through to it.
		const existing = await shard.data.get(backupKey, { blob: true });
		const backup = Uint8Array.from(world.terrainBlob);
		const touched = applyUniform(world.terrain, template, layout, sealing);
		await Promise.all([
			existing === null ? shard.data.set(backupKey, backup) : undefined,
			shard.data.set('terrain', makeWriter(worldSchema)(world.terrain)),
		]);
		report.written = true;
		report.ringFaces = touched.length - layout.rooms.length;
	}
	const before: ObjectLosses[] = [];
	const after = new Map<string, ObjectLosses>();
	for (const name of layout.rooms) {
		try {
			const room = await shard.loadRoom(name, time);
			const terrain = coveredTerrain(template, name, sealing.sealCore ? layout.core : []);
			// The before state is read out of the saved room, so a dry run and a real run agree.
			before.push(objectLosses(room, terrain));
			if (plan !== undefined && place !== undefined && !objectsMatch(room, plan, place)) {
				await backupRoom(shard, name);
				const placed = placeObjects(room, plan, terrain, place);
				// Both double-buffer slots, so whichever tick first processes the room reads the new
				// objects -- `shard.saveRoom` writes one slot and the room is served from either.
				await Promise.all([
					shard.saveRoom(name, time, room),
					shard.saveRoom(name, time + 1, room),
				]);
				report.objects.moved += placed.moved;
				report.objects.added += placed.added;
				report.objects.removed += placed.removed;
				if (placed.nudged !== 0) {
					report.objects.nudged += placed.nudged;
					report.nudgedRooms.push(name);
				}
				if (placed.blocked.length !== 0) {
					report.blockedRooms.push(name);
				}
				++report.roomsWritten;
			}
			after.set(name, objectLosses(room, terrain));
		} catch (error) {
			report.failedRooms.push(name);
		}
	}
	report.lossesBefore = sumLosses(before);
	report.lossesAfter = sumLosses([ ...after.values() ]);
	report.flagged = [ ...after ]
		.filter(([ , losses ]) => losses.sources !== 0 || losses.minerals !== 0 || losses.controllers !== 0)
		.map(([ name ]) => name);
	return report;
}

/**
 * Puts the terrain and the rooms back the way they were before the first stamp. Returns false when
 * there is nothing to restore -- a world which was never stamped has no backup.
 */
export async function restoreUniform(shard: Shard) {
	const backup = await shard.data.get(backupKey, { blob: true });
	if (backup === null) {
		return { terrain: false, rooms: 0 };
	}
	const world = await shard.loadWorld();
	const layout = uniformLayout(world.terrain, sectorCoreRooms(world.terrain));
	await using gameMutex = await Mutex.connect('game', shard.data, shard.pubsub);
	await using lock = await gameMutex.acquire();
	await shard.data.set('terrain', backup);
	let rooms = 0;
	for (const name of layout.rooms) {
		const slots = await Promise.all([ 0, 1 ].map(slot =>
			shard.data.get(`${roomBackupKey}/${slot}/${name}`, { blob: true })));
		const writes = slots
			.map((blob, slot) => blob === null ? undefined : shard.data.set(`room${slot}/${name}`, blob))
			.filter(write => write !== undefined);
		if (writes.length !== 0) {
			await Promise.all(writes);
			++rooms;
		}
	}
	return { terrain: true, rooms };
}
