import { config } from 'xxscreeps/config/index.js';
import { createSeasonRace } from 'xxscreeps/mods/speedrun/race-lifecycle.js';
import { isSeason2Room } from './rooms.js';

const race = createSeasonRace({
	namespace: 'speedrun-season2',
	containsRoom: isSeason2Room,
	getSettings: () => config.speedrunSeason2,
});

// Step 8 exposes only landing lifecycle and queues, not scoring, resets or leaderboard reads.
export const { dueRunsKey, racingKey, runKey, raceBrackets, startRun, stopRun } = race;
