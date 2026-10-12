import { config } from 'xxscreeps/config/index.js';
import { createRace } from './race-core.js';
import { isSpeedrunRoom } from './scope.js';

export type { LeaderboardEntry, PlayerRecord, RaceRecord, RacingEntry } from './race-core.js';
export { controlPointsOf, runIdOf } from './race-core.js';

// Racing results: how far a player's room had come a fixed number of ticks after they landed in it.
//
// Six tables account scoped (`db.data`, like GCL and the leaderboard, so a result does
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
//   - `speedrun/racing` (`shard.data`) — one entry per run, the clock the run is measured by: the
//     live board reads the rooms of these, and the restart at the end of a window is looked up in it
//     (`resetRun`). An entry goes when the handover lands -- not when the last bracket is scored --
//     so a run is never left playing with nothing on the clock; the board hides the ones which are
//     over rather than losing them.
//
// A result is only recorded for a player who still holds the room with a controller above the entry
// bar; see `captureBracket`. Between them, that covers `unclaim`, a downgrade to zero and a respawn:
// the run stops scoring and the player simply has no further results.
//
// A run also ends on its own: `respawnAfter` ticks after the landing the server hands the player
// over -- the same `unspawn` a respawn does, and nothing else, so the player places their next spawn
// themselves. See `resetExpiredRuns` below. A run is timed from its landing until it is handed over
// or superseded, whether or not the room is still held, so an abandoned base is picked up by the
// next round instead of being left spent.

// Preserve every public season-1 function and storage key. The shared core knows neither
// config.speedrun nor W/N geography; this adapter supplies both without registering new hooks.
const race = createRace({
	namespace: 'speedrun',
	containsRoom: isSpeedrunRoom,
	getSettings: () => config.speedrun,
});

export const {
	dueRunsKey, racingKey, runKey, scoreKey, rankKey, bestKey, playerRunsKey, playerBracketsKey,
	raceBrackets, respawnAfter, startRun, stopRun, captureBracket, captureDueBrackets, resetExpiredRuns,
	readLeaderboard, readPlayerBrackets, readPlayerRecords, readRacing,
} = race;
