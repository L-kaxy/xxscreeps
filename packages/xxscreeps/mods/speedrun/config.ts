export interface SpeedrunSettings {
	/**
	 * Whether the periodic raid generator runs. With this off a room's harvest budget is cleared on
	 * every tick so no raiding party spawns. A room which banked a budget before this was switched
	 * off may still see one last raid.
	 * @default false
	 */
	invaders?: boolean;

	/**
	 * Whether the periodic deposit generator (`mods/modern/deposit`) runs. With this off the
	 * generator's placement intent is dropped, so no new deposit is ever put down: the evaluator
	 * keeps walking the sector schedule and the intent keeps arriving, but nothing lands. Deposits
	 * already in the world are untouched -- they keep their cooldown, keep being harvested and decay
	 * on schedule, and their decay no longer triggers a refill. Set it to `true` to get vanilla
	 * placement back.
	 * @default false
	 */
	deposits?: boolean;

	/**
	 * Whether the periodic power bank generator (`mods/modern/powerbank`) runs. With this off the
	 * generator's placement intent is dropped, so no new bank is ever put down; banks already in the
	 * world are untouched and decay on schedule. Set it to `true` to get vanilla placement back.
	 * @default false
	 */
	powerBanks?: boolean;

	/**
	 * Whether a destroyed structure leaves a ruin behind. With this off a ruin never reaches the
	 * room: the object `Structure['#destroy']` and the two spawn intents hand to
	 * `Room['#insertObject']` is dropped at the door (`processor.ts` explains why that one method
	 * covers every lane), so nothing is left to loot and nothing is left to decay. The two spawn
	 * intents matter most here -- the ruins of a handover or of an abandoned base carry a
	 * `100000`/`500000` tick decay and sit in the room for hours, where the ruin of a structure
	 * killed in combat is gone within `RUIN_DECAY` (500) ticks.
	 *
	 * No room blob format changes: the room schema keeps its `ruin` variant and a ruin is never
	 * written to storage in the first place. The `EVENT_OBJECT_DESTROYED` entry of the structure
	 * which died is still appended, so combat logs and statistics are unaffected. Tombstones, which
	 * are what a dying creep leaves, are not touched. Set it to `true` for vanilla ruins.
	 * @default false
	 */
	ruins?: boolean;

	/**
	 * Whether the neutral structures a leaving player left behind are cleared out when they respawn.
	 * A respawn takes every object the player owns out of their rooms and releases the controllers,
	 * but the structures they built which nobody owns -- roads, containers, walls -- carry no owner,
	 * so nothing there touches them: a container never decays and stays in the room for good.
	 *
	 * On by default, this clears those three types out of the rooms the player was using, in the
	 * same tick as the handover (`respawn.ts` explains the room list and the guards). A room they
	 * owned or reserved is cleared outright; a room they only had creeps in is cleared only while no
	 * other player is standing in it, so a room which is being fought over is left alone. Resources
	 * stored in a container go with it, and the destruction is logged the same way any kill is. The
	 * world's own neutral structures -- power banks, deposits, portals and controllers -- are never
	 * on the list. Set it to `false` to leave the leftovers standing.
	 * @default true
	 */
	respawnCleanup?: boolean;

	/**
	 * Whether creeps may claim neutral controllers. With this off `Creep.claimController` returns
	 * `ERR_INVALID_TARGET` before it records an intent, so no room in the world can change hands.
	 * Nothing else about controllers changes: `reserveController`, `attackController` and
	 * `upgradeController` still work, and the starting room the backend hands a new player is claimed
	 * through its own `placeSpawn` intent, which does not go through this API. Set it to `true` to
	 * let players claim again.
	 * @default false
	 */
	claimController?: boolean;

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
		deposits: false,
		powerBanks: false,
		ruins: false,
		respawnCleanup: true,
		claimController: false,
		closeCenterNine: true,
		wallSectorCores: true,
	},
} satisfies SpeedrunConfig;
