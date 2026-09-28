import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { TemplateSpec } from './template.js';
import { config } from 'xxscreeps/config/index.js';
import { schema as worldSchema } from 'xxscreeps/game/map.js';
import { Source } from 'xxscreeps/mods/classic/source/source.js';
import { makeWriter } from 'xxscreeps/schema/write.js';
import { sectorCoreRooms } from './rooms.js';
import {
	applyUniform, coveredTerrain, generateTemplate, hasStandingRoom, isSwampType, isUniform, isWallType,
	kMaxSwampType, kMaxTerrainType, uniformLayout,
} from './template.js';

/**
 * One terrain for the whole interior.
 *
 * Every room of every sector's 9x9 interior -- everything but the core, i.e. 72 rooms of the stock
 * world -- is overwritten with a single generated template, so no room is a better start than
 * another. The template is generated the way `generate-room` generates a room (see `template.ts` for
 * the layouts, the exits and the one repair it can make), applied once, and kept: the shard stores
 * the terrain and the layout it came from, so a restart, a rollback or a redeploy does not change
 * the world.
 *
 * Terrain is the only thing written. No room blob is rewritten and no object is read, moved or
 * deleted, which is why the last thing this does is *report* the objects a wall landed next to: a
 * source with no plain ground beside it can never be mined, and only the operator can decide what to
 * do about that. Rooms around a core keep the face which looks at it sealed, exactly as
 * `wallSectorCores` leaves it, and the highway ring keeps its own terrain except for the eight tiles
 * of each face which looks at a covered room -- without those the outermost rooms would advertise an
 * exit the ring seals.
 */

/** The layout a template was generated from, so a restart regenerates nothing. */
interface StoredSpec extends TemplateSpec {
	/** Bumped when the generator itself changes, which forces a fresh template. */
	format: number;
}

const kFormat = 1;
const specKey = 'speedrun/uniformSpec';
const templateKey = 'speedrun/uniformTerrain';
const backupKey = 'speedrun/terrainBackup';
const kDefaultExitWidth = 8;

/** The exit width an operator gets without saying so: even, so the opening is centred. */
function resolveExitWidth(value: unknown): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 46 && value % 2 === 0
		? value
		: kDefaultExitWidth;
}

/** The layout the operator asked for, rolling whatever they left out the way `generate-room` does. */
function resolveSpec(): TemplateSpec {
	const settings = config.speedrun;
	return {
		terrainType: isWallType(settings?.uniformTerrainType)
			? settings.uniformTerrainType
			: Math.floor(Math.random() * kMaxTerrainType) + 1,
		swampType: isSwampType(settings?.uniformSwampType)
			? settings.uniformSwampType
			: Math.floor(Math.random() * kMaxSwampType),
		exitWidth: resolveExitWidth(settings?.uniformExitWidth),
	};
}

/**
 * Whether the stored layout is still the one being asked for. A key the operator left out matches
 * anything -- it is the stored value which holds its roll -- so an unset layout does not roll a new
 * template on every start.
 */
function sameSpec(stored: StoredSpec, settings: NonNullable<typeof config.speedrun>): boolean {
	return stored.format === kFormat &&
		(settings.uniformTerrainType === undefined || settings.uniformTerrainType === stored.terrainType) &&
		(settings.uniformSwampType === undefined || settings.uniformSwampType === stored.swampType) &&
		resolveExitWidth(settings.uniformExitWidth) === stored.exitWidth;
}

/**
 * The template this shard uses: the one it already holds while the layout still matches, a freshly
 * generated one otherwise. A template is generated once and stored, so the world only changes when
 * the operator changes the layout.
 */
async function loadTemplate(shard: Shard) {
	const settings = config.speedrun ?? {};
	const [ storedSpec, storedTemplate ] = await Promise.all([
		shard.data.get(specKey),
		shard.data.get(templateKey, { blob: true }),
	]);
	if (storedSpec !== null && storedTemplate !== null) {
		try {
			const parsed = JSON.parse(storedSpec) as StoredSpec;
			if (sameSpec(parsed, settings)) {
				return { spec: parsed, template: storedTemplate, generated: false };
			}
		} catch {}
	}
	const spec = resolveSpec();
	const { terrain, repaired, attempts } = generateTemplate(spec);
	await Promise.all([
		shard.data.set(specKey, JSON.stringify({ ...spec, format: kFormat })),
		shard.data.set(templateKey, terrain),
	]);
	return { spec, template: terrain, generated: true, repaired, attempts };
}

/**
 * Reports the objects a wall landed next to, per room. A room's sources read as usable when a creep
 * can stand beside them -- the tile an object occupies is not walkable either way, so only the ring
 * around it matters -- and the template is one open region, so any plain neighbour counts.
 */
async function reportObjects(shard: Shard, names: readonly string[], template: Readonly<Uint8Array>, core: readonly string[]) {
	const flagged: string[] = [];
	let lostSources = 0;
	let lostOthers = 0;
	let deadRooms = 0;
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
		if (sources !== 0 && usableSources === 0) {
			deadRooms++;
		}
	}
	if (flagged.length === 0) {
		console.log('speedrun: every object keeps open ground beside it');
	} else {
		console.log(`speedrun: ${lostSources} source(s) and ${lostOthers} other object(s) have no open ` +
			`ground beside them, in ${flagged.join(' ')}${deadRooms === 0 ? '' : `, ${deadRooms} room(s) left without a source`}`);
	}
}

/**
 * Applies the shard's template to the world, and writes the terrain blob once. A world which already
 * holds it is left untouched, so this costs one terrain read per service start.
 */
export async function stampUniformRooms(shard: Shard) {
	const world = await shard.loadWorld();
	const core = sectorCoreRooms(world.terrain);
	const layout = uniformLayout(world.terrain, core);
	if (layout.core.length === 0 || layout.rooms.length === 0) {
		console.log('speedrun: no sector records in this world, so there is no interior to cover');
		return;
	}
	const options = {
		ringEdges: config.speedrun?.uniformRingEdges !== false,
		sealCore: config.speedrun?.wallSectorCores !== false,
	};
	const { spec, template, generated, repaired, attempts } = await loadTemplate(shard);
	if (isUniform(world.terrain, template, layout, options)) {
		return;
	}

	// Rollback material: the world's terrain as it is now, written once and never overwritten. Taken
	// as a copy because the room records read out of the blob may write through to it.
	const existingBackup = await shard.data.get(backupKey, { blob: true });
	const backup = Uint8Array.from(world.terrainBlob);
	const touched = applyUniform(world.terrain, template, layout, options);
	await Promise.all([
		existingBackup === null ? shard.data.set(backupKey, backup) : undefined,
		shard.data.set('terrain', makeWriter(worldSchema)(world.terrain)),
	]);
	const ringFaces = touched.length - layout.rooms.length;
	console.log(`speedrun: covered ${layout.rooms.length} rooms with terrain type ${spec.terrainType}/swamp ` +
		`${spec.swampType}, ${spec.exitWidth} tile exits${generated ? ' (generated)' : ' (stored)'}` +
		`${repaired ? `, repaired after ${attempts + 1} attempts` : ''}` +
		`${ringFaces > 0 ? `, opened ${ringFaces} highway ring faces` : ''}`);
	await reportObjects(shard, layout.rooms, template, options.sealCore ? layout.core : []);
}
