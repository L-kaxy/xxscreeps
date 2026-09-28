import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import * as C from 'xxscreeps:mods/constants';

// Racing results: how far a player's room had come a fixed number of ticks after they landed in it.
//
// Five tables, four of them account scoped (`db.data`, like GCL and the leaderboard, so a result does
// not depend on which shard measured it):
//
//   - `speedrun/run/<userId>` — one hash per player, overwritten by every landing: which room the
//     current run is played in, the tick it started, and which run number it is. A landing always
//     supersedes the previous run.
//   - `speedrun/score/<bracket>/<runId>` — one hash per run per bracket, never overwritten, so a
//     player who lands, scores, and lands again keeps both results.
//   - `speedrun/rank/<bracket>` — every result of the bracket, scored by control points. A record's
//     place among *all* runs comes from here, so an older run keeps the standing it earned.
//   - `speedrun/best/<bracket>` — one entry per player holding their best result, which is the row a
//     list page shows. One row per player, ordered by that best.
//   - `speedrun/runs/<bracket>/<userId>` — one player's runs in one bracket, so a profile page lists
//     them without walking every record; `speedrun/brackets/<userId>` says which brackets they have
//     results in and what their best is in each.
//
// ..and two scoped to the shard, because they describe the race rather than the result:
//
//   - `speedrun/due` (`shard.data`) — the schedule, one entry per (run, bracket), which the shard tick
//     processor drains when a bracket comes due. The brackets are tick offsets rather than wall-clock
//     times, so a shard which is paused or down freezes the race instead of voiding it.
//   - `speedrun/racing` (`shard.data`) — the runs in progress, for the live board which reads the
//     rooms straight out of storage.
//
// A result is only recorded for a player who still holds the room with a controller above the entry
// bar; see `captureBracket`. Between them, that covers `unclaim`, a downgrade to zero and a respawn:
// the run stops scoring and the player simply has no further results.

/** The tick offsets recorded after a landing, e.g. `[ 20000, 40000 ]`. Empty records nothing. */
export function raceBrackets(): readonly number[] {
	return config.speedrun?.raceBrackets ?? [];
}

export const dueRunsKey = 'speedrun/due';
export const racingKey = 'speedrun/racing';
export const runKey = (userId: string) => `speedrun/run/${userId}`;
export const scoreKey = (bracket: number, runId: string) => `speedrun/score/${bracket}/${runId}`;
export const rankKey = (bracket: number) => `speedrun/rank/${bracket}`;
export const bestKey = (bracket: number) => `speedrun/best/${bracket}`;
export const playerRunsKey = (bracket: number, userId: string) => `speedrun/runs/${bracket}/${userId}`;
export const playerBracketsKey = (userId: string) => `speedrun/brackets/${userId}`;

/** `<userId>:<run>` — unique per landing, so an earlier run keeps its own results. */
export const runIdOf = (userId: string, run: number) => `${userId}:${run}`;
/** `<userId>:<run>:<bracket>` — what sits in the schedule. A player id contains no `:`. */
const dueMemberOf = (userId: string, run: number, bracket: number) => `${runIdOf(userId, run)}:${bracket}`;

function parseDueMember(member: string) {
	const [ userId, run, bracket ] = member.split(':');
	if (userId !== undefined && run !== undefined && bracket !== undefined) {
		return { bracket: Number(bracket), run: Number(run), userId };
	}
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

/**
 * A player landed in a room: start a new run at `time` and put every bracket in the schedule. Run
 * numbers only ever count up, which is what keeps the results of an earlier run readable (and lets a
 * stale schedule entry recognize that it has been superseded). The run is also put on the live board,
 * replacing whatever entry the player had there.
 */
export async function startRun(shard: Shard, userId: string, roomName: string, time: number): Promise<number | undefined> {
	const brackets = raceBrackets();
	if (brackets.length === 0) {
		return undefined;
	}
	const previous = await shard.db.data.hGet(runKey(userId), 'run');
	const run = Number(previous ?? 0) + 1;
	await Promise.all([
		shard.db.data.hSet(runKey(userId), 'run', String(run)),
		shard.db.data.hSet(runKey(userId), 'room', roomName),
		shard.db.data.hSet(runKey(userId), 'startedTick', String(time)),
		...brackets.map(bracket =>
			shard.data.zAdd(dueRunsKey, [ [ time + bracket, dueMemberOf(userId, run, bracket) ] ])),
		// The run this one replaces is off the live board the moment a new one starts.
		...(previous === null ? [] : [ shard.data.zRem(racingKey, [ runIdOf(userId, run - 1) ]) ]),
		shard.data.zAdd(racingKey, [ [ time, runIdOf(userId, run) ] ]),
	]);
	return run;
}

/**
 * Capture one scheduled bracket. Returns the run id when a result was recorded, and `undefined` for
 * every reason a player has no result at that bracket — which is every case the ruleset cares about:
 * a run which a later landing superseded, a room which is no longer theirs, and a controller below
 * the entry bar (`RCL < 2`). The first two also take the run off the live board; a controller below
 * the bar does not, since the race is still on until the room is gone.
 */
export async function captureBracket(shard: Shard, member: string, time: number) {
	const parsed = parseDueMember(member);
	if (parsed === undefined || !raceBrackets().includes(parsed.bracket)) {
		return undefined;
	}
	const { bracket, run, userId } = parsed;
	const runId = runIdOf(userId, run);
	const runInfo = await shard.db.data.hGetAll(runKey(userId));
	if (Number(runInfo.run ?? 0) !== run || runInfo.room === undefined) {
		// A later landing took over, or the run was never recorded.
		await shard.data.zRem(racingKey, [ runId ]);
		return undefined;
	}
	const room = await shard.loadRoom(runInfo.room).catch(() => undefined);
	const controller = room?.controller;
	if (room === undefined || controller === undefined
		|| controller['#user'] !== userId || room['#user'] !== userId) {
		// The room is gone, or was taken over: the run is out of the race.
		await shard.data.zRem(racingKey, [ runId ]);
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
	const best = await shard.db.data.zScore(bestKey(bracket), userId);
	// The list page shows one row per player, so a run which is not an improvement only adds a record.
	const improves = best === null || controlPoints > best;
	await Promise.all([
		...Object.entries(fields).map(([ field, value ]) =>
			shard.db.data.hSet(scoreKey(bracket, runId), field, value)),
		shard.db.data.zAdd(rankKey(bracket), [ [ controlPoints, runId ] ]),
		shard.db.data.zAdd(playerRunsKey(bracket, userId), [ [ controlPoints, String(run) ] ]),
		improves ? shard.db.data.zAdd(bestKey(bracket), [ [ controlPoints, userId ] ]) : undefined,
		improves ? shard.db.data.hSet(playerBracketsKey(userId), String(bracket), String(controlPoints)) : undefined,
		// The last bracket ends the run; an earlier one leaves it on the live board.
		bracket === lastBracket() ? shard.data.zRem(racingKey, [ runId ]) : undefined,
	]);
	return runId;
}

/**
 * Drain every bracket which came due at (or before) `time`. Each entry is claimed out of the
 * schedule before it is captured, so a bracket is captured at most once and a failed capture cannot
 * turn into a late one — an entry which produces no result simply disappears.
 */
export async function captureDueBrackets(shard: Shard, time: number) {
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
				console.log(`speedrun: recorded ${member} at tick ${time}`);
			}
		} catch (error) {
			// A scheduled entry must never take the shard's tick loop down with it.
			console.error(`speedrun: failed to capture ${member} at tick ${time}`, error);
		}
	}));
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
 * The result behind a player's `best` entry: their highest scoring run in the bracket. The runs of
 * one player are a short list, so it is read in full rather than indexed separately.
 */
async function readBest(shard: Shard, bracket: number, userId: string) {
	const runs = await shard.db.data.zRangeWithScores(
		playerRunsKey(bracket, userId), -Infinity, Infinity, { by: 'SCORE' });
	const run = runs[runs.length - 1];
	if (run === undefined) {
		return undefined;
	}
	return parseRecord(await shard.db.data.hGetAll(scoreKey(bracket, runIdOf(userId, Number(run[1])))));
}

export interface LeaderboardEntry {
	/** Zero based, as the client expects */
	rank: number;
	record: RaceRecord | undefined;
	score: number;
	user: string;
}

/** One page of a bracket: one row per player, their best result, highest first. */
export async function readLeaderboard(shard: Shard, bracket: number, offset: number, limit: number) {
	const key = bestKey(bracket);
	const [ count, page ] = await Promise.all([
		shard.db.data.zCard(key),
		shard.db.data.zRangeWithScores(key, offset, offset + limit - 1, { rev: true }),
	]);
	const list = await Promise.all(page.map(async ([ score, user ], index): Promise<LeaderboardEntry> => ({
		rank: offset + index,
		record: await readBest(shard, bracket, user),
		score,
		user,
	})));
	return { count, list };
}

/** The brackets a player has results in, with their best score in each, lowest bracket first. */
export async function readPlayerBrackets(shard: Shard, userId: string) {
	const brackets = await shard.db.data.hGetAll(playerBracketsKey(userId));
	return Object.entries(brackets)
		.map(([ bracket, score ]) => ({ bracket: Number(bracket), score: Number(score) }))
		.sort((left, right) => left.bracket - right.bracket);
}

/** A single record plus its place among every run of the bracket. */
export interface PlayerRecord {
	bracket: number;
	/** Zero based; `null` when the record is not on the bracket's board */
	rank: number | null;
	record: RaceRecord;
	score: number;
}

/** Every result a player holds, best first within each bracket. */
export async function readPlayerRecords(shard: Shard, userId: string, brackets: readonly number[]) {
	const lists = await Promise.all(brackets.map(async bracket => {
		const runs = await shard.db.data.zRangeWithScores(
			playerRunsKey(bracket, userId), -Infinity, Infinity, { by: 'SCORE' });
		const records = await Promise.all(runs.reverse().map(async ([ score, run ]): Promise<PlayerRecord> => {
			const runId = runIdOf(userId, Number(run));
			const [ fields, rank ] = await Promise.all([
				shard.db.data.hGetAll(scoreKey(bracket, runId)),
				shard.db.data.zRank(rankKey(bracket), runId, { rev: true }),
			]);
			return { bracket, rank, record: parseRecord(fields), score };
		}));
		return records;
	}));
	return lists.flat();
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

/**
 * The runs in progress, current to the tick: each one is read out of its room rather than out of a
 * stored result, since a run which has not reached a bracket has nothing else recorded. An entry
 * whose run was superseded or whose room is gone is dropped from the board as it is read.
 */
export async function readRacing(shard: Shard, time: number) {
	const racing = await shard.data.zRangeWithScores(racingKey, -Infinity, Infinity, { by: 'SCORE' });
	const stale: string[] = [];
	const entries = await Promise.all(racing.map(async ([ startedTick, runId ]): Promise<RacingEntry | undefined> => {
		const separator = runId.indexOf(':');
		const userId = runId.slice(0, separator);
		const run = Number(runId.slice(separator + 1));
		const info = await shard.db.data.hGetAll(runKey(userId));
		const roomName = info.room;
		if (Number(info.run ?? 0) !== run || roomName === undefined) {
			// A later landing took over: this entry describes a run which is over.
			stale.push(runId);
			return undefined;
		}
		// Room initialization is skipped: this is a read, and it must not queue anything. The room is
		// read at `time` rather than at whatever tick the caller's shard last saw.
		const room = await shard.loadRoom(roomName, time, true).catch(() => undefined);
		const controller = room?.controller;
		if (room === undefined || controller === undefined
			|| controller['#user'] !== userId || room['#user'] !== userId) {
			// The room is no longer theirs, which ends the run the way a lost bracket would.
			stale.push(runId);
			return undefined;
		}
		const level = controller.level;
		const progress = controller.progress ?? 0;
		return {
			brackets: raceBrackets().map(bracket => ({
				bracket,
				dueTick: startedTick + bracket,
				left: startedTick + bracket - time,
			})),
			elapsed: time - startedTick,
			level,
			progress,
			progressTotal: controller.progressTotal ?? 0,
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
