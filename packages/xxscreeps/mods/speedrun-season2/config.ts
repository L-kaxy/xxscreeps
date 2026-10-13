/**
 * Independent season-2 settings for E1N1 through E9N9.
 * Initial spawn is fixed; periodic Invaders and manual cleanup are configurable.
 * Deposits, power banks, claiming and ruins remain global switches under `speedrun`.
 */
export interface SpeedrunSeason2Settings {
	/**
	 * Whether periodic Invader generation runs in the season-2 block.
	 * Does not remove existing Invaders or disable Source Keepers or manual Invader requests.
	 * @default false
	 */
	invaders?: boolean;

	/**
	 * Whether season-2 respawn clears all artificial buildings and construction sites in its block.
	 * Completed Extractors in E4N4 through E6N6 are preserved.
	 * Player respawn itself still removes the player's objects from all rooms.
	 * @default true
	 */
	respawnCleanup?: boolean;

	/**
	 * Tick offsets after a successful season-2 landing at which results are captured.
	 * An empty list disables scoring.
	 * @default [20000, 40000]
	 */
	raceBrackets?: number[];

	/**
	 * Run duration in ticks before automatic respawn; zero or less disables automatic respawn.
	 * @default 40000
	 */
	respawnAfter?: number;
}

export interface SpeedrunSeason2Config {
	/**
	 * Independent season-2 settings; global switches exist only under `speedrun`.
	 * Initial spawn, Invaders, scoring and manual cleanup are connected; automatic reset arrives later.
	 */
	speedrunSeason2?: SpeedrunSeason2Settings;
}

declare module 'xxscreeps/config/config.js' {
	interface Config extends SpeedrunSeason2Config {}
}

export const initializationDefaults = {
	speedrunSeason2: {
		invaders: false,
		respawnCleanup: true,
		raceBrackets: [ 20000, 40000 ],
		respawnAfter: 40000,
	},
} satisfies SpeedrunSeason2Config;
