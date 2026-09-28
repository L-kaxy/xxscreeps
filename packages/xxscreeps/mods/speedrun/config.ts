export interface SpeedrunSettings {
	/**
	 * Whether the periodic raid generator runs. With this off a room's harvest budget is cleared on
	 * every tick so no raiding party spawns. A room which banked a budget before this was switched
	 * off may still see one last raid.
	 * @default false
	 */
	invaders?: boolean;
}

export interface SpeedrunConfig {
	/**
	 * Speedrun ruleset settings
	 */
	speedrun?: SpeedrunSettings;
}

declare module 'xxscreeps/config/config.js' {
	interface Config extends SpeedrunConfig {}
}

/**
 * Merged into the running configuration, and written to a newly generated `.screepsrc.yaml` so the
 * switch shows up in the file operators actually edit.
 */
export const initializationDefaults = {
	speedrun: {
		invaders: false,
	},
} satisfies SpeedrunConfig;
