// Run through the existing xxscreeps file: entry point in the running container.
// No Database.connect(), Shard.loadRoom(), schema upgrade, save(), or game mutation.
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const dist = process.env.XXSCREEPS_DEBUG_DIST ?? '/xxscreeps/node_modules/xxscreeps/dist';
const load = name => import(pathToFileURL(`${dist}/${name}.js`).href);
const roomName = process.env.DEBUG_ROOM ?? 'W2N2';
const allRooms = process.env.DEBUG_ALL_ROOMS === '1';
const output = process.env.DEBUG_OUTPUT ?? '/tmp/xxscreeps-room-debug.json';
const timeout = setTimeout(() => {
	console.error(`Export timed out. Check the existing container's working directory and storage sockets. Output, if already written: ${output}`);
	process.exit(2);
}, 45000);

const errors = [];
const describe = error => error?.stack ?? String(error);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const versionId = version => {
	const bytes = Buffer.alloc(4);
	bytes.writeUInt32LE(version);
	return bytes.toString('hex');
};

try {
	const { config, configPath } = await load('config/index');
	const { mods } = await load('config/mods');
	const { connectToProvider } = await load('engine/db/storage/index');
	const { getResponderSocketPath } = await load('engine/db/storage/local/responder');
	const shard = process.env.DEBUG_SHARD
		? config.shards.find(value => value.name === process.env.DEBUG_SHARD)
		: config.shards[0];
	if (!shard) {
		throw new Error('Requested shard not found in the active configuration.');
	}

	// For local storage, refuse a missing socket rather than opening offline data stores.
	for (const uri of [ config.database.data, shard.data, ...(allRooms ? [ shard.scratch ] : []) ]) {
		const url = new URL(uri, configPath);
		if (url.protocol === 'file:' || url.protocol === 'local:') {
			if (config.database.lock == null) {
				throw new Error('Local live export requires the configured database.lock. No storage connection attempted.');
			}
			const socket = getResponderSocketPath(url);
			if (!socket || !(await fs.stat(socket)).isSocket()) {
				throw new Error('Live storage socket not found. Run inside the existing, running server container with its configuration working directory.');
			}
		}
	}

	const resources = new AsyncDisposableStack();
	try {
		// Connect only to raw key-value providers, avoiding schema archiving side effects.
		const database = resources.use(await connectToProvider(config.database.data, 'keyval'));
		const data = resources.use(await connectToProvider(shard.data, 'keyval'));
		const diagnostics = {};
		let roomNames = [ roomName ];
		if (allRooms) {
			const scratch = resources.use(await connectToProvider(shard.scratch, 'keyval'));
			const time = await data.get('time');
			const [ openRooms, activeRooms, sleepingRooms, processingRooms, queue, pending, finalizing ] = await Promise.all([
				data.sMembers('rooms'),
				scratch.zRange('processor/activeRooms', 0, -1),
				scratch.zRange('processor/inactiveRooms', 0, -1),
				scratch.sMembers(`tick${time}/processedRooms`),
				scratch.zRangeWithScores(`tick${time}/processRooms`, 0, -1),
				scratch.get(`tick${time}/processRoomsPending`),
				scratch.get(`tick${time}/finalizedRoomsPending`),
			]);
			Object.assign(diagnostics, {
				time,
				openRooms,
				activeRooms,
				sleepingRooms,
				processingRooms,
				processQueue: queue,
				processRoomsPending: pending,
				finalizedRoomsPending: finalizing,
			});
			roomNames = [ ...new Set([
				roomName, ...openRooms, ...activeRooms, ...sleepingRooms, ...processingRooms,
				...queue.map(([ , name ]) => name),
			]) ].sort();
			if (roomNames.length > 1000) {
				throw new Error('More than 1000 rooms selected; narrow the export instead of taking an unbounded live snapshot.');
			}
		}
		const readPair = async () => {
			const entries = [];
			// Limit the number of outstanding storage requests on the running server.
			for (let start = 0; start < roomNames.length; start += 16) {
				const batch = await Promise.all(roomNames.slice(start, start + 16).flatMap(name =>
					[ 0, 1 ].map(async parity => {
						const key = `room${parity}/${name}`;
						const value = await data.get(key, { blob: true });
						return { key, bytes: value === null ? null : Buffer.from(value) };
					})));
				entries.push(...batch);
			}
			return entries;
		};

		let before, after, captured, stable = false, attempts = 0;
		for (; attempts < 6; ++attempts) {
			before = await data.get('time');
			captured = await readPair();
			const second = await readPair();
			after = await data.get('time');
			stable = before === after && captured.every((entry, index) => {
				const next = second[index].bytes;
				return entry.bytes === null ? next === null : next !== null && entry.bytes.equals(next);
			});
			if (stable) {
				++attempts;
				break;
			}
			if (attempts < 5) {
				await delay(20);
			}
		}

		const archives = {};
		const rooms = [];
		for (const { key, bytes } of captured) {
			if (bytes === null) {
				rooms.push({ key, missing: true });
				continue;
			}
			let header = null;
			let archiveKey = null;
			if (bytes.length >= 16) {
				const version = bytes.readUInt32LE(4);
				header = {
					magic: bytes.readUInt32LE(0),
					version,
					versionHexLE: versionId(version),
					declaredLength: bytes.readUInt32LE(8),
					reserved: bytes.readUInt32LE(12),
				};
				archiveKey = `schema/Room/${versionId(version)}`;
				if (!(archiveKey in archives)) {
					try {
						archives[archiveKey] = await database.hGet(archiveKey, 'archive');
					} catch (error) {
						errors.push({ stage: archiveKey, error: describe(error) });
						archives[archiveKey] = null;
					}
				}
			}
			rooms.push({
				key,
				byteLength: bytes.length,
				sha256: hash(bytes),
				header,
				archiveKey,
				base64: bytes.toString('base64'),
			});
		}

		// Installed engine code helps detect an image/local-source mismatch. No game objects
		// are instantiated, and no getters, effects, archived code, or player code are executed.
		const installedSources = {};
		for (const name of [
			'mods/modern/stronghold/schema',
			'mods/modern/stronghold/processor',
			'mods/modern/stronghold/game',
			'mods/classic/road/schema',
			'mods/classic/road/game',
			'game/room/schema',
			'engine/schema/build/index',
			'schema/overlay',
			'schema/read',
		]) {
			try {
				installedSources[name] = await fs.readFile(`${dist}/${name}.js`, 'utf8');
			} catch (error) {
				errors.push({ stage: `source/${name}`, error: describe(error) });
			}
		}

		const report = {
			format: 'xxscreeps-room-debug-v1',
			exportedAt: new Date().toISOString(),
			node: process.version,
			cwd: process.cwd(),
			configPath: configPath.href,
			roomName,
			roomNames,
			allRooms,
			shardName: shard.name,
			diagnostics,
			snapshot: {
				timeBefore: before,
				timeAfter: after,
				stableAcrossRepeatedReads: stable,
				attempts,
				currentRoomKey: Number.isSafeInteger(Number(after)) && after !== null
					? `room${Number(after) % 2}/${roomName}` : null,
				note: 'Repeated-read consistency check only; no game lock was acquired. These are current buffers, not historical tick backups.',
			},
			mods: mods.map(mod => ({ url: mod.url, provides: mod.provides })),
			rooms,
			archives,
			installedSources,
			errors,
		};
		await fs.writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
		console.log(`Exported ${roomNames.length} room(s) / ${shard.name} to ${output}`);
		console.log(`Repeated reads stable: ${stable}; ticks: ${before} -> ${after}`);
		console.log(`Buffers: ${rooms.length}; missing: ${rooms.filter(room => room.missing).length}`);
		if (!stable) {
			console.warn('Capture crossed updates; preserve this export and capture again if possible.');
		}
		if (errors.length) {
			console.warn(`Export contains ${errors.length} diagnostic warning(s).`);
		}
	} finally {
		await resources.disposeAsync();
	}
} finally {
	clearTimeout(timeout);
}
