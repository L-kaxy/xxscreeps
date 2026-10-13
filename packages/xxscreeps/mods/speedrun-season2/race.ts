import { config } from 'xxscreeps/config/index.js';
import { createSeasonRace } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import { isSeason2Room } from './rooms.js';

const race = createSeasonRace({
	namespace: 'speedrun-season2',
	containsRoom: isSeason2Room,
	getSettings: () => config.speedrunSeason2,
	captureOnce: true,
});

export type { LeaderboardEntry, PlayerRecord, RaceRecord } from 'xxscreeps/mods/speedrun/race-core.js';
export { controlPointsOf, runIdOf } from 'xxscreeps/mods/speedrun/race-core.js';

// Scoring/storage adapter. Manual cleanup is separate; no automatic reset, HTTP API or page hook here.
export const {
	dueRunsKey, racingKey, runKey, scoreKey, rankKey, bestKey, playerRunsKey, playerBracketsKey,
	raceBrackets, startRun, stopRun, captureBracket, captureDueBrackets,
	readLeaderboard, readPlayerBrackets, readPlayerRecords,
} = race;
