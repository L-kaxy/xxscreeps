export interface SpeedrunSettings {
	/**
	 * Whether the periodic raid generator runs. With this off a room's harvest budget is cleared on
	 * every tick so no raiding party spawns. A room which banked a budget before this was switched
	 * off may still see one last raid.
	 * @default false
	 */
	invaders?: boolean;

	/**
	 * Whether the sector cores -- each sector's center room plus its eight neighbours, i.e. the
	 * central 3x3 -- are closed on every service start. Closing drops the room from the world's
	 * open-room list, which is what `Game.map.getRoomStatus()` reports as `{ status: 'closed' }`;
	 * nothing inside the room is read, moved or deleted, and no other room is touched. The rooms are
	 * taken from the world's own sector records, so a world with more than one sector is covered
	 * without any further configuration.
	 * @default false
	 */
	closeCenterNine?: boolean;
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
		closeCenterNine: false,
	},
} satisfies SpeedrunConfig;
