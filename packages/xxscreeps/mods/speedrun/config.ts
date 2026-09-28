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
	 * without any further configuration. Set it to `false` on a shard which wants its cores playable.
	 * @default true
	 */
	closeCenterNine?: boolean;

	/**
	 * Whether the sector cores are painted solid on service start: every tile of the nine rooms of
	 * each core becomes wall, together with the facing edge of the room on each side of them -- the
	 * row a creep would have to walk along before it is handed across the border into the core, which
	 * is the step that has to be refused (`walls.ts` explains why the core alone would not be
	 * enough). On unless this is set to `false`, so a shard gets a solid core without editing
	 * anything.
	 *
	 * Terrain is the only thing written. Nothing inside the rooms is read, moved or deleted, no room
	 * blob is rewritten, and the sector record on the center room survives, so the deposit and power
	 * bank schedules which read their highway rooms out of it keep working. The world's original
	 * terrain blob is kept under `speedrun/terrainBackup`, so writing that back lifts the wall.
	 *
	 * Services read the world blob while they boot, so a wall written by this rule takes effect on
	 * the service start *after* the one which writes it.
	 * @default true
	 */
	wallSectorCores?: boolean;
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
		closeCenterNine: true,
		wallSectorCores: true,
	},
} satisfies SpeedrunConfig;
