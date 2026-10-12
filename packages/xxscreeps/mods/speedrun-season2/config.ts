/**
 * Independent season-2 settings for E1N1 through E9N9.
 * The initial-spawn room rule is fixed; these configurable gameplay hooks arrive in later steps.
 * Deposits and power banks remain global switches under `speedrun`.
 */
export interface SpeedrunSeason2Settings {
	/**
	 * Whether periodic Invader generation runs in the season-2 block.
	 * @default false
	 */
	invaders?: boolean;

	/**
	 * Whether destroyed structures in the season-2 block leave ruins.
	 * @default false
	 */
	ruins?: boolean;

	/**
	 * Whether season-2 respawn clears all artificial buildings and construction sites in its block.
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

	/**
	 * Whether creeps in the season-2 block may claim other controllers.
	 * @default false
	 */
	claimController?: boolean;
}

export interface SpeedrunSeason2Config {
	/**
	 * Independent season-2 configuration; never falls back to season-1 settings.
	 * Configurable gameplay rules are connected in subsequent development steps.
	 */
	speedrunSeason2?: SpeedrunSeason2Settings;
}

declare module 'xxscreeps/config/config.js' {
	interface Config extends SpeedrunSeason2Config {}
}

export const initializationDefaults = {
	speedrunSeason2: {
		invaders: false,
		ruins: false,
		respawnCleanup: true,
		raceBrackets: [ 20000, 40000 ],
		respawnAfter: 40000,
		claimController: false,
	},
} satisfies SpeedrunSeason2Config;
