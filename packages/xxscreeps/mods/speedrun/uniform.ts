import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { schema as worldSchema } from 'xxscreeps/game/map.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { sectorCoreRooms } from './rooms.js';
import {
	applyUniform, coveredTerrain, generateTemplate, hasStandingRoom, isUniform, kMaxSwampType, kMaxTerrainType,
	templateExitWidth, uniformLayout,
} from './template.js';

/**
 * One terrain for the whole interior, as the `uniform-terrain` command runs it.
 *
 * Every room of every sector's 9x9 interior -- everything but the core, 72 rooms of the stock world
 * -- is overwritten with one generated template, so no room is a better start than another. The
 * template is `generate-room`'s own generator (`template.ts` has the layouts, the exits and the one
 * repair it can make); what this module adds is the write: the terrain blob, once, with the world's
 * terrain from before it put aside so `--restore` can lift the whole thing again.
 *
 * Terrain is the only thing written. No room blob is rewritten and no object is read, moved or
 * deleted, which is why the objects a wall landed next to are *reported* rather than moved: a source
 * with no plain ground beside it can never be mined, and only the operator can decide about that.
 */

/** Where the terrain from before the first stamp is kept, the key `wallSectorCores` also uses. */
export const backupKey = 'speedrun/terrainBackup';

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
}

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
	lostSources: number;
	lostOthers: number;
	/** Rooms where an object lost its footing, with the ones left without a source marked. */
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

/**
 * Reports the objects a wall landed next to, per room. A room's sources read as usable when a creep
 * can stand beside them -- the tile an object occupies is not walkable either way, so only the ring
 * around it matters -- and a covered room's plain tiles are one region, so any plain neighbour
 * counts.
 */
async function reportObjects(shard: Shard, names: readonly string[], template: Readonly<Uint8Array>, core: readonly string[]) {
	const flagged: string[] = [];
	let lostSources = 0;
	let lostOthers = 0;
	for (const name of names) {
		const room = await shard.loadRoom(name);
		const terrain = coveredTerrain(template, name, core);
		let sources = 0;
		let usableSources = 0;
		let lost = 0;
		for (const object of room['#objects']) {
			const usable = hasStandingRoom(terrain, object.pos.x, object.pos.y);
			const isSource = object instanceof Source;
			if (isSource) {
				sources++;
				usableSources += usable ? 1 : 0;
			}
			if (!usable) {
				lost++;
				if (isSource) {
					lostSources++;
				} else {
					lostOthers++;
				}
			}
		}
		if (lost !== 0) {
			flagged.push(sources !== 0 && usableSources === 0 ? `${name} (no usable source)` : name);
		}
	}
	return { lostSources, lostOthers, flagged };
}

/**
 * Stamps the interior with one template. A dry run reads everything and writes nothing; a world which
 * already holds the template writes nothing either.
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
		lostSources: 0,
		lostOthers: 0,
		flagged: [],
	};
	if (!options.dryRun && !isUniform(world.terrain, template, layout, sealing)) {
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
	Object.assign(report, await reportObjects(
		shard,
		layout.rooms,
		template,
		sealing.sealCore ? layout.core : [],
	));
	return report;
}

/**
 * Puts the terrain back the way it was before the first stamp. Returns false when there is nothing to
 * restore -- a world which was never stamped has no backup.
 */
export async function restoreTerrain(shard: Shard) {
	const backup = await shard.data.get(backupKey, { blob: true });
	if (backup === null) {
		return false;
	}
	await shard.data.set('terrain', backup);
	return true;
}
