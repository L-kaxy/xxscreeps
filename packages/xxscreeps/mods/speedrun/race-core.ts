import type { Shard } from 'xxscreeps/engine/db/shard.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { primitiveComparator } from 'xxscreeps/functional/comparator.js';
import { controlledRoomsKey } from 'xxscreeps/mods/classic/controller/model.js';
import { respawnPlayer } from 'xxscreeps/mods/classic/spawn/model.js';
import * as C from 'xxscreeps:mods/constants';

/** Only the race settings shared by seasons; this module reads no global config. */
export interface RaceSettings {
	raceBrackets?: readonly number[];
	respawnAfter?: number;
}

/** Explicit season inputs. Constructing a race does not register hooks or access storage. */
export interface RaceDefinition<Namespace extends string = string> {
	readonly namespace: Namespace;
	readonly containsRoom: (name: string | undefined) => boolean;
	readonly getSettings: () => Readonly<RaceSettings> | undefined;
	/** Real seasons share a persistent activity guard; standalone core consumers remain independent. */
	readonly isCurrentRun?: (shard: Shard, userId: string, info: Record<string, string>) => Promise<boolean>;
	readonly withPlayerLock?: <Result>(shard: Shard, userId: string, task: () => Promise<Result>) => Promise<Result>;
	/** Opt-in for new seasons: replaying a captured bracket must not overwrite its historical result. */
	readonly captureOnce?: boolean;
}

/** Six account-level tables and two shard-level queues, all in the supplied namespace. */
export function makeRaceKeys<Namespace extends string>(namespace: Namespace) {
	return {
		dueRunsKey: `${namespace}/due`,
		racingKey: `${namespace}/racing`,
		runKey: (userId: string) => `${namespace}/run/${userId}`,
		scoreKey: (bracket: number, runId: string) => `${namespace}/score/${bracket}/${runId}`,
		rankKey: (bracket: number) => `${namespace}/rank/${bracket}`,
		bestKey: (bracket: number) => `${namespace}/best/${bracket}`,
		playerRunsKey: (bracket: number, userId: string) => `${namespace}/runs/${bracket}/${userId}`,
		playerBracketsKey: (userId: string) => `${namespace}/brackets/${userId}`,
	} as const;
}

/** A recorded result, as the pages render it. */
export interface RaceRecord {
	/** The timestamp the result entered the board */
	at: number;
	bracket: number;
	elapsed: number;
	gcl: number;
	level: number;
	progress: number;
	progressTotal: number;
	room: string;
	run: number;
	runId: string;
	score: number;
	startedTick: number;
	tick: number;
	user: string;
	username: string;
}

export interface LeaderboardEntry {
	/** Zero based, as the client expects */
	rank: number;
	record: RaceRecord | undefined;
	score: number;
	user: string;
}

/** A single record plus its place among every run of the bracket. */
export interface PlayerRecord {
	bracket: number;
	/** Zero based; `null` when the record is not on the bracket's board */
	rank: number | null;
	record: RaceRecord;
	score: number;
}

/** A run in progress, read out of the room it is being played in. */
export interface RacingEntry {
	brackets: { bracket: number; dueTick: number; left: number }[];
	elapsed: number;
	level: number;
	progress: number;
	progressTotal: number;
	room: string;
	run: number;
	runId: string;
	score: number;
	startedTick: number;
	user: string;
}

/** `<userId>:<run>` — unique per landing, so an earlier run keeps its own results. */
export const runIdOf = (userId: string, run: number) => `${userId}:${run}`;

/** `<userId>:<run>:<bracket>` — what sits in the schedule. A player id contains no `:`. */
const dueMemberOf = (userId: string, run: number, bracket: number) => `${runIdOf(userId, run)}:${bracket}`;

/** The `userId` and run number behind a `<userId>:<run>` id. */
function parseRunId(runId: string) {
	const separator = runId.indexOf(':');
	const userId = runId.slice(0, separator);
	const run = Number(runId.slice(separator + 1));
	return { run, userId };
}

function parseDueMember(member: string) {
	const [ userId, run, bracket ] = member.split(':');
	if (userId !== undefined && run !== undefined && bracket !== undefined) {
		return { bracket: Number(bracket), run: Number(run), userId };
	}
}

/**
 * Control points behind a controller: every level passed in full plus the progress on the current
 * one — the total a rank page orders players by, so RCL breaks ties on how far into it they got.
 */
export function controlPointsOf(level: number, progress: number) {
	let points = progress;
	for (let ii = 1; ii < level; ++ii) {
		points += C.CONTROLLER_LEVELS[ii] ?? 0;
	}
	return points;
}

function parseRecord(fields: Record<string, string>): RaceRecord {
	const numeric = (field: string) => Number(fields[field] ?? 0);
	return {
		at: numeric('at'),
		bracket: numeric('bracket'),
		elapsed: numeric('elapsed'),
		gcl: numeric('gcl'),
		level: numeric('level'),
		progress: numeric('progress'),
		progressTotal: numeric('progressTotal'),
		room: fields.room ?? '',
		run: numeric('run'),
		runId: fields.runId ?? '',
		score: numeric('controlPoints'),
		startedTick: numeric('startedTick'),
		tick: numeric('tick'),
		user: fields.user ?? '',
		username: fields.username ?? '',
	};
}

/**
 * Shared race implementation with no provider registration. Reads settings at call time so
 * adapters retain the original live-config behavior, rather than capturing a startup snapshot.
 * Only the caller's namespace and room predicate participate in scheduling, scoring and reads.
 */
export function createRace<Namespace extends string>({
	namespace, containsRoom, getSettings, isCurrentRun, withPlayerLock, captureOnce = false,
}: RaceDefinition<Namespace>) {
	const keys = makeRaceKeys(namespace);
	const { dueRunsKey, racingKey, runKey, scoreKey, rankKey, bestKey, playerRunsKey, playerBracketsKey } = keys;

	/** The tick offsets recorded after a landing, e.g. `[ 20000, 40000 ]`. Empty records nothing. */
	function raceBrackets(): readonly number[] {
		return getSettings()?.raceBrackets ?? [];
	}

	/**
	 * How many ticks a run lasts before the player is restarted, or `0` when runs are never restarted.
	 * The configuration wins; without it the last bracket is used, so the restart follows the race.
	 */
	function respawnAfter(): number {
		const after = getSettings()?.respawnAfter ?? lastBracket();
		return after > 0 ? after : 0;
	}

	/** The last bracket of a run, which is the one that takes the run off the live board. */
	function lastBracket() {
		let last = 0;
		for (const bracket of raceBrackets()) {
			last = Math.max(last, bracket);
		}
		return last;
	}

	/**
	 * A player landed in a room: start a new run at `time` and put every bracket in the schedule. Run
	 * numbers only ever count up, which is what keeps the results of an earlier run readable (and lets a
	 * stale schedule entry recognize that it has been superseded). The run is also put on the live board,
	 * replacing whatever entry the player had there.
	 */
	async function startRun(shard: Shard, userId: string, roomName: string, time: number): Promise<number | undefined> {
		const brackets = raceBrackets();
		if (!containsRoom(roomName) || brackets.length === 0) {
			return undefined;
		}
		const previous = await shard.db.data.hGet(runKey(userId), 'run');
		const run = Number(previous ?? 0) + 1;
		await Promise.all([
			shard.db.data.hSet(runKey(userId), 'run', String(run)),
			shard.db.data.hSet(runKey(userId), 'room', roomName),
			shard.db.data.hSet(runKey(userId), 'startedTick', String(time)),
			// Landing here clears the end-of-run mark of the run this one replaces: a run which has
			// already been handed over is not handed over again.
			shard.db.data.hDel(runKey(userId), [ 'endedTick' ]),
			...brackets.map(bracket =>
				shard.data.zAdd(dueRunsKey, [ [ time + bracket, dueMemberOf(userId, run, bracket) ] ])),
			// The run this one replaces is off the live board the moment a new one starts.
			...previous === null ? [] : [ shard.data.zRem(racingKey, [ runIdOf(userId, run - 1) ]) ],
			shard.data.zAdd(racingKey, [ [ time, runIdOf(userId, run) ] ]),
		]);
		return run;
	}

	/** End the old clock when a player lands outside this season, without deleting historical results. */
	async function stopRun(shard: Shard, userId: string, time: number) {
		const info = await shard.db.data.hGetAll(runKey(userId));
		if (info.run === undefined) {
			return;
		}
		const run = Number(info.run);
		const due = await shard.data.zRange(dueRunsKey, -Infinity, Infinity, { by: 'SCORE' });
		const members = due.filter(member => {
			const parsed = parseDueMember(member);
			return parsed?.userId === userId && parsed.run === run;
		});
		await Promise.all([
			shard.db.data.hSet(runKey(userId), 'endedTick', String(time)),
			shard.data.zRem(racingKey, [ runIdOf(userId, run) ]),
			members.length === 0 ? undefined : shard.data.zRem(dueRunsKey, members),
		]);
	}

	/**
	 * Capture one scheduled bracket. Returns the run id when a result was recorded, and `undefined` for
	 * every reason a player has no result at that bracket — which is every case the ruleset cares about:
	 * a run which a later landing superseded, a room which is no longer theirs, and a controller below
	 * the entry bar (`RCL < 2`). A superseded run comes off the live board (its player is on a newer
	 * one); a lost room does not, since the run is still on the clock and the player will be restarted
	 * at the end of it. Scoring the last bracket does not take the run off the board either: the entry
	 * is the run's clock, the handle the restart at the end of the window is found by (`resetRun`), so it
	 * goes when the handover lands rather than when the last result does. The board hides a run whose
	 * window is out instead (`readRacing`).
	 */
	async function captureBracket(shard: Shard, member: string, time: number) {
		const parsed = parseDueMember(member);
		if (parsed === undefined || !raceBrackets().includes(parsed.bracket)) {
			return undefined;
		}
		return withPlayerLock
			? withPlayerLock(shard, parsed.userId, () => captureCurrentBracket(shard, parsed, time))
			: captureCurrentBracket(shard, parsed, time);
	}

	async function captureCurrentBracket(
		shard: Shard, { bracket, run, userId }: { bracket: number; run: number; userId: string }, time: number,
	) {
		const runId = runIdOf(userId, run);
		const runInfo = await shard.db.data.hGetAll(runKey(userId));
		if (Number(runInfo.run ?? 0) !== run || runInfo.room === undefined || !containsRoom(runInfo.room)) {
			// A later landing took over, or the run was never recorded.
			await shard.data.zRem(racingKey, [ runId ]);
			return undefined;
		}
		if (runInfo.endedTick !== undefined) {
			return undefined;
		}
		if (isCurrentRun && !await isCurrentRun(shard, userId, runInfo)) {
			await stopRun(shard, userId, time);
			return undefined;
		}
		if (captureOnce && await shard.db.data.hGet(scoreKey(bracket, runId), 'tick') !== null) {
			// Real season adapters hold the player lock across this check and all score/index writes.
			return undefined;
		}
		const room = await shard.loadRoom(runInfo.room).catch(() => undefined);
		const controller = room?.controller;
		if (room === undefined || controller?.['#user'] !== userId || room['#user'] !== userId) {
			// The room is gone, or was taken over: nothing scores here. The run stays on the clock, so
			// the player is picked up by the restart at the end of it like anybody else.
			return undefined;
		}
		if (controller.level < 2) {
			// Below the entry bar: nothing to record at this bracket, but the run is still on.
			return undefined;
		}
		const startedTick = Number(runInfo.startedTick ?? time);
		const level = controller.level;
		const progress = controller.progress ?? 0;
		const controlPoints = controlPointsOf(level, progress);
		const username = await shard.db.data.hGet(User.infoKey(userId), 'username') ?? '';
		const gcl = Number(await shard.db.data.hGet(User.infoKey(userId), 'gcl') ?? 0);
		const fields: Record<string, string> = {
			// The timestamp the result entered the board
			at: String(Date.now()),
			bracket: String(bracket),
			controlPoints: String(controlPoints),
			elapsed: String(time - startedTick),
			gcl: String(gcl),
			level: String(level),
			progress: String(progress),
			progressTotal: String(controller.progressTotal ?? 0),
			room: runInfo.room,
			run: String(run),
			runId,
			startedTick: String(startedTick),
			tick: String(time),
			user: userId,
			username,
		};
		// An older out-of-sector result must not prevent this room's first valid best.
		const best = (await readBest(shard, bracket, userId))?.score;
		// The list page shows one row per player, so a run which is not an improvement only adds a record.
		const improves = best === undefined || controlPoints > best;
		await Promise.all([
			...Object.entries(fields).map(([ field, value ]) =>
				shard.db.data.hSet(scoreKey(bracket, runId), field, value)),
			shard.db.data.zAdd(rankKey(bracket), [ [ controlPoints, runId ] ]),
			shard.db.data.zAdd(playerRunsKey(bracket, userId), [ [ controlPoints, String(run) ] ]),
			improves ? shard.db.data.zAdd(bestKey(bracket), [ [ controlPoints, userId ] ]) : undefined,
			improves ? shard.db.data.hSet(playerBracketsKey(userId), String(bracket), String(controlPoints)) : undefined,
		]);
		return runId;
	}

	/**
	 * Drain every bracket which came due at (or before) `time`. Each entry is claimed out of the
	 * schedule before it is captured, so a bracket is captured at most once and a failed capture cannot
	 * turn into a late one — an entry which produces no result simply disappears.
	 */
	async function captureDueBrackets(shard: Shard, time: number) {
		// Score range, not the default rank range: `zRange` without `by` walks by index.
		const due = await shard.data.zRange(dueRunsKey, -Infinity, time, { by: 'SCORE' });
		if (due.length === 0) {
			return;
		}
		await shard.data.zRem(dueRunsKey, due);
		await Promise.all(due.map(async member => {
			try {
				const runId = await captureBracket(shard, member, time);
				if (runId !== undefined) {
					console.log(`${namespace}: recorded ${member} at tick ${time}`);
				}
			} catch (error) {
				// A scheduled entry must never take the shard's tick loop down with it.
				console.error(`${namespace}: failed to capture ${member} at tick ${time}`, error);
			}
		}));
	}

	/**
	 * Restart every run whose landing has reached the end of its window: the player is handed over the
	 * way a respawn hands them over -- every room they are present in gets the engine's `unspawn`, which
	 * takes their objects and releases the controllers -- and that is all. No spawn is put back down;
	 * the next landing, which is the player placing one themselves, opens their next run.
	 *
	 * The handover is queued as an intent for the next tick, so the work happens in the room processor
	 * like any other respawn. The run records the tick it was queued on (`endedTick`), which is what
	 * keeps a second handover from taking out whatever the player has put down since, and a landing
	 * clears it.
	 */
	async function resetExpiredRuns(shard: Shard, time: number) {
		const after = respawnAfter();
		if (after === 0) {
			return;
		}
		// The live board is scored by the tick of the landing, so a run at the end of its window is
		// simply the low end of the set.
		const expired = await shard.data.zRange(racingKey, -Infinity, time - after, { by: 'SCORE' });
		await Promise.all(expired.map(async runId => {
			try {
				await resetRun(shard, runId, time);
			} catch (error) {
				// A restart must never take the shard's tick loop down with it.
				console.error(`${namespace}: failed to restart ${runId} at tick ${time}`, error);
			}
		}));
	}

	/** How long a handed-over run is watched for its next landing before it is left alone. */
	const resetGiveUpAfter = 50;

	async function resetRun(shard: Shard, runId: string, time: number) {
		return withPlayerLock
			? withPlayerLock(shard, parseRunId(runId).userId, () => resetCurrentRun(shard, runId, time))
			: resetCurrentRun(shard, runId, time);
	}

	async function resetCurrentRun(shard: Shard, runId: string, time: number) {
		const { run, userId } = parseRunId(runId);
		const [ info, username ] = await Promise.all([
			shard.db.data.hGetAll(runKey(userId)),
			shard.db.data.hGet(User.infoKey(userId), 'username'),
		]);
		if (Number(info.run ?? 0) !== run || username === null || !containsRoom(info.room)) {
			// A later landing took over, or the account is gone: there is nobody to hand over.
			await shard.data.zRem(racingKey, [ runId ]);
			return;
		}
		if (isCurrentRun && !await isCurrentRun(shard, userId, info)) {
			await stopRun(shard, userId, time);
			return;
		}
		const controlled = await shard.scratch.sMembers(controlledRoomsKey(userId));
		if (controlled.some(name => !containsRoom(name))) {
			// A newer landing may have come through a different mod or an administrative import.
			await stopRun(shard, userId, time);
			return;
		}
		const endedTick = info.endedTick === undefined ? undefined : Number(info.endedTick);
		if (endedTick === undefined) {
			// The handover is marked with the tick it started on, which is what the give-up window below
			// is measured from.
			await shard.db.data.hSet(runKey(userId), 'endedTick', String(time));
		}
		// The handover is the respawn itself rather than a lookalike: the same call the `/api/user/respawn`
		// route makes, with the room the run started in named as the one room there always is a name for.
		// It goes out on every tick of the window rather than once, because a handover can miss -- and one
		// nobody performs is invisible from the outside, leaving the player playing a run which reads as
		// restarted.
		const rooms = await respawnPlayer(shard, userId, info.room === undefined ? [] : [ info.room ]);
		const since = time - (endedTick ?? time);
		if (since <= resetGiveUpAfter) {
			// Within the give-up window the handover is queued on every tick, so it lands as soon as there
			// is a tick whose room processing can perform it.
			return;
		}
		// Past it the handover is re-queued on this cadence rather than every tick: a room which has not
		// come back by now is not waiting on a retry. `since % 50 === 1` is 51, 101, 151, ...
		if (since % resetGiveUpAfter !== 1) {
			return;
		}
		// The window is out. The rooms are read once more, because a handover which never landed is worth
		// a line in the log -- that is the one way this goes wrong without looking wrong: the run reads as
		// restarted while the player is still playing it.
		const stillHolding: string[] = [];
		await Promise.all(rooms.map(async roomName => {
			const room = await shard.loadRoom(roomName, time).catch(() => null);
			if (room === null || room['#user'] === userId
				|| room['#objects'].some(object => object['#user'] === userId)) {
				stillHolding.push(roomName);
			}
		}));
		if (stillHolding.length !== 0) {
			// The handover has not landed. The entry stays, and so does the retry, rather than being let go
			// with the player still playing the run: it is the only handle on this run, and nothing else
			// would ever put them back on the clock.
			console.warn(`${namespace}: ${userId} still holds ${stillHolding.join(' ')} ${since} tick(s) ` +
				'after the restart window');
			return;
		}
		// Handed over, and no landing since: the run is over. Nothing is waiting on the clock -- their
		// next run starts from the landing, not from here -- so the entry is dropped rather than read
		// every so often for the rest of the shard's life.
		await shard.data.zRem(racingKey, [ runId ]);
	}

	/**
	 * The result behind a player's `best` entry: their highest scoring run in the bracket. The runs of
	 * one player are a short list, so it is read in full rather than indexed separately.
	 */
	async function readBest(shard: Shard, bracket: number, userId: string) {
		const runs = await shard.db.data.zRangeWithScores(
			playerRunsKey(bracket, userId), Infinity, -Infinity, { by: 'SCORE', rev: true });
		for (const [ , run ] of runs) {
			const fields = await shard.db.data.hGetAll(scoreKey(bracket, runIdOf(userId, Number(run))));
			if (containsRoom(fields.room)) {
				return parseRecord(fields);
			}
		}
		return undefined;
	}

	/** One page of a bracket: one row per player, their best result, highest first. */
	async function readLeaderboard(shard: Shard, bracket: number, offset: number, limit: number) {
		const key = bestKey(bracket);
		// Filter before pagination: historical global entries must not consume a page slot or rank.
		const candidates = await shard.db.data.zRange(key, 0, -1, { rev: true });
		const records = await Promise.all(candidates.map(async user => ({ user, record: await readBest(shard, bracket, user) })));
		const valid = records.flatMap(({ user, record }) =>
			record === undefined ? [] : [ { user, record, score: record.score } ]);
		valid.sort((left, right) => right.score - left.score || primitiveComparator(right.user, left.user));
		const list: LeaderboardEntry[] = valid.slice(offset, offset + limit)
			.map((entry, index) => ({ ...entry, rank: offset + index }));
		return { count: valid.length, list };
	}

	/** The brackets a player has results in, with their best score in each, lowest bracket first. */
	async function readPlayerBrackets(shard: Shard, userId: string) {
		const brackets = await shard.db.data.hGetAll(playerBracketsKey(userId));
		const best = await Promise.all(Object.keys(brackets).map(async value => {
			const bracket = Number(value);
			const record = await readBest(shard, bracket, userId);
			return record === undefined ? [] : [ { bracket, score: record.score } ];
		}));
		return best.flat()
			.sort((left, right) => left.bracket - right.bracket);
	}

	/** Every result a player holds, best first within each bracket. */
	async function readPlayerRecords(shard: Shard, userId: string, brackets: readonly number[]) {
		const lists = await Promise.all(brackets.map(async bracket => {
			const rankedRuns = await shard.db.data.zRange(rankKey(bracket), 0, -1, { rev: true });
			const rankedRooms = await Promise.all(rankedRuns.map(runId => shard.db.data.hGet(scoreKey(bracket, runId), 'room')));
			const ranks = new Map(rankedRuns.filter((_runId, index) => containsRoom(rankedRooms[index] ?? undefined))
				.map((runId, index) => [ runId, index ]));
			const runs = await shard.db.data.zRangeWithScores(
				playerRunsKey(bracket, userId), -Infinity, Infinity, { by: 'SCORE' });
			const records = await Promise.all(runs.reverse().map(async ([ score, run ]): Promise<PlayerRecord | undefined> => {
				const runId = runIdOf(userId, Number(run));
				const fields = await shard.db.data.hGetAll(scoreKey(bracket, runId));
				if (!containsRoom(fields.room)) {
					return undefined;
				}
				return { bracket, rank: ranks.get(runId) ?? null, record: parseRecord(fields), score };
			}));
			return records.flatMap(record => record === undefined ? [] : [ record ]);
		}));
		return lists.flat();
	}

	/**
	 * The runs in progress, current to the tick: each one is read out of its room rather than out of a
	 * stored result, since a run which has not reached a bracket has nothing else recorded. An entry
	 * whose run was superseded is dropped from the board as it is read; one of a room which belongs to
	 * somebody else is hidden, but kept, so the restart at the end of the window still finds it; and one
	 * whose window is out -- the handover has been queued, `resetRun` -- is hidden for the same reason,
	 * since the entry stays until the handover lands.
	 */
	async function readRacing(shard: Shard, time: number) {
		const racing = await shard.data.zRangeWithScores(racingKey, -Infinity, Infinity, { by: 'SCORE' });
		const stale: string[] = [];
		const entries = await Promise.all(racing.map(async ([ startedTick, runId ]): Promise<RacingEntry | undefined> => {
			const { run, userId } = parseRunId(runId);
			const info = await shard.db.data.hGetAll(runKey(userId));
			const roomName = info.room;
			if (Number(info.run ?? 0) !== run || roomName === undefined || !containsRoom(roomName)) {
				// A later landing took over: this entry describes a run which is over.
				stale.push(runId);
				return undefined;
			}
			if (isCurrentRun && !await isCurrentRun(shard, userId, info)) {
				stale.push(runId);
				return undefined;
			}
			if (info.endedTick !== undefined) {
				// The window is out: the run is over, and the handover which closes it is on its way.
				return undefined;
			}
			// The room is read at `time` rather than at whatever tick the caller's shard last saw, and it
			// is read *initialized*: `controller` is a typed accessor, and a room which was never
			// initialized has none -- which is how a run reads as `RCL 0` while the room it is played in
			// is held at RCL 4. Nothing read here is saved, so the initialize pass costs a read and
			// changes nothing. The level falls back to the room's own field, which is what the controller
			// mod's own read paths use (`mods/classic/controller/backend.ts:52-55`).
			const room = await shard.loadRoom(roomName, time).catch(() => undefined);
			const controller = room?.controller;
			// The owner of the room, as the controller mod keeps it: a string once the controller has been
			// claimed or reserved, `null` while it is still free, and absent when the room has none at all.
			// Only a room which belongs to somebody else is one the run has lost -- a landing whose
			// controller has not been claimed yet is a run at level zero, which is exactly what the first
			// minutes of every race look like. A room which cannot be read is not evidence that it is gone
			// either, so the entry is left on the board and read as level zero rather than disappearing.
			const owner = controller?.['#user'] ?? room?.['#user'] ?? null;
			if (owner !== null && owner !== userId) {
				// Taken over by another player: there is no progress to show. The run itself is still on
				// the clock and is restarted at the end of it, so it is left where it is.
				return undefined;
			}
			const level = controller?.level ?? room?.['#level'] ?? 0;
			const progress = controller?.progress ?? 0;
			return {
				brackets: raceBrackets().map(bracket => ({
					bracket,
					dueTick: startedTick + bracket,
					left: startedTick + bracket - time,
				})),
				elapsed: time - startedTick,
				level,
				progress,
				progressTotal: controller?.progressTotal ?? 0,
				room: roomName,
				run,
				runId,
				score: controlPointsOf(level, progress),
				startedTick,
				user: userId,
			};
		}));
		const list = entries.flatMap(entry => entry === undefined ? [] : [ entry ]);
		if (stale.length !== 0) {
			await shard.data.zRem(racingKey, stale);
		}
		list.sort((left, right) => right.score - left.score);
		return list;
	}

	return {
		...keys,
		raceBrackets,
		respawnAfter,
		startRun,
		stopRun,
		captureBracket,
		captureDueBrackets,
		resetExpiredRuns,
		readLeaderboard,
		readPlayerBrackets,
		readPlayerRecords,
		readRacing,
	};
}
