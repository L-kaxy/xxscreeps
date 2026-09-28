import type { Shard } from 'xxscreeps/engine/db/shard.js';
import { config } from 'xxscreeps/config/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import * as C from 'xxscreeps:mods/constants';

// Racing results: how far a player's room had come a fixed number of ticks after they landed in it.
//
// Two tables, both in `db.data` (account scoped, like GCL and the leaderboard, so a result does not
// depend on which shard measured it):
//
//   - `speedrun/run/<userId>` — one hash per player, overwritten by every landing: which room the
//     current run is played in, the tick it started, and which run number it is. A landing always
//     supersedes the previous run.
//   - `speedrun/score/<bracket>/<runId>` — one hash per run per bracket, never overwritten, so a
//     player who lands, scores, and lands again keeps both results.
//
// ..and the sorted index `speedrun/rank/<bracket>` (score = control points, member = run id) which
// is what a list page reads: ranking without it would mean walking every record.
//
// `shard.data`'s `speedrun/due` is the schedule — one entry per (run, bracket) — which the shard
// tick processor drains when a bracket comes due. The brackets are tick offsets rather than
// wall-clock times, so a shard which is paused or down freezes the race instead of voiding it.
//
// A result is only recorded for a player who still holds the room with a controller above the entry
// bar; see `captureBracket`. Between them, that covers `unclaim`, a downgrade to zero and a
// respawn: the run stops scoring and the player simply has no further results.

/** The tick offsets recorded after a landing, e.g. `[ 20000, 40000 ]`. Empty records nothing. */
export function raceBrackets(): readonly number[] {
	return config.speedrun?.raceBrackets ?? [];
}

export const dueRunsKey = 'speedrun/due';
export const runKey = (userId: string) => `speedrun/run/${userId}`;
export const scoreKey = (bracket: number, runId: string) => `speedrun/score/${bracket}/${runId}`;
export const rankKey = (bracket: number) => `speedrun/rank/${bracket}`;

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
 * numbers only ever count up, which is what keeps the results of an earlier run readable (and lets
 * a stale schedule entry recognize that it has been superseded).
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
	]);
	return run;
}

/**
 * Capture one scheduled bracket. Returns the run id when a result was recorded, and `undefined` for
 * every reason a player has no result at that bracket — which is every case the ruleset cares about:
 * a run which a later landing superseded, a room which is no longer theirs, and a controller below
 * the entry bar (`RCL < 2`).
 */
export async function captureBracket(shard: Shard, member: string, time: number) {
	const parsed = parseDueMember(member);
	if (parsed === undefined || !raceBrackets().includes(parsed.bracket)) {
		return undefined;
	}
	const { bracket, run, userId } = parsed;
	const runInfo = await shard.db.data.hGetAll(runKey(userId));
	if (Number(runInfo.run ?? 0) !== run || runInfo.room === undefined) {
		// A later landing took over, or the run was never recorded.
		return undefined;
	}
	const room = await shard.loadRoom(runInfo.room);
	const controller = room.controller;
	if (
		controller === undefined ||
		controller['#user'] !== userId ||
		room['#user'] !== userId ||
		controller.level < 2
	) {
		// The room is gone, was taken over, or never got above the entry bar.
		return undefined;
	}
	const runId = runIdOf(userId, run);
	const startedTick = Number(runInfo.startedTick ?? time);
	const progress = controller.progress ?? 0;
	const controlPoints = controlPointsOf(controller.level, progress);
	const username = await shard.db.data.hGet(User.infoKey(userId), 'username') ?? '';
	const gcl = Number(await shard.db.data.hGet(User.infoKey(userId), 'gcl') ?? 0);
	const fields: Record<string, string> = {
		// The timestamp the result entered the board
		at: String(Date.now()),
		bracket: String(bracket),
		controlPoints: String(controlPoints),
		elapsed: String(time - startedTick),
		gcl: String(gcl),
		level: String(controller.level),
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
	await Promise.all([
		...Object.entries(fields).map(([ field, value ]) =>
			shard.db.data.hSet(scoreKey(bracket, runId), field, value)),
		shard.db.data.zAdd(rankKey(bracket), [ [ controlPoints, runId ] ]),
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

interface ScoreEntry {
	rank: number;
	runId: string;
	score: number;
	user: string;
}

/**
 * One page of a bracket, highest score first, with the entries behind it. Used by the rank page
 * (the HTTP route is not wired up yet).
 */
export async function readBracketPage(shard: Shard, bracket: number, offset: number, limit: number) {
	const [ count, page ] = await Promise.all([
		shard.db.data.zCard(rankKey(bracket)),
		shard.db.data.zRangeWithScores(rankKey(bracket), offset, offset + limit - 1, { rev: true }),
	]);
	const list: ScoreEntry[] = page.map(([ score, runId ], index) => ({
		rank: offset + index,
		runId,
		score,
		user: runId.slice(0, runId.indexOf(':')),
	}));
	const scores = await Promise.all(list.map(entry => shard.db.data.hGetAll(scoreKey(bracket, entry.runId))));
	return { count, list, scores };
}
