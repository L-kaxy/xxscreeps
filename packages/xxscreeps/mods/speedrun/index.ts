import type { Manifest } from 'xxscreeps/config/mods.js';
import * as types from 'xxscreeps/tsroot.js';

// speedrun — custom ruleset for this shard.
//
// This mod is the single place where "speedrun" server rules live, so that the upstream tree stays
// untouched and the ruleset can be turned on and off per deployment by editing the mods list.
// Enable it by appending its specifier to `mods` in `.screepsrc.yaml`:
//
//    mods:
//      - xxscreeps/mods/classic
//      - xxscreeps/mods/speedrun
//
// `classic` is declared as a dependency so that it always loads first: speedrun's rules are
// expressed as adjustments on top of the vanilla ruleset, not as a replacement for it.
//
// Rules implemented so far, all configured under the `speedrun` key (see `config.ts`):
//
//    - `invaders` (default `false`): the periodic raid generator is suppressed by keeping rooms
//      from banking an invasion budget. See `processor.ts` for the mechanism, and `test.ts` for
//      the assertions which pin it down.
//
//    - `closeCenterNine` (default `true`): the sector cores -- each sector's center room plus its
//      eight neighbours, the same central 3x3 the vanilla server's `closeRoom` console command was
//      aimed at -- are dropped from the world's open-room list on every service start, which is
//      what `Game.map.getRoomStatus()` reports as `closed`. Nothing inside them is read or deleted,
//      and no other room is touched. See `main.ts` for the mechanism and `rooms.ts` for how the
//      rooms are picked (out of the world's own sector records, not out of room names). Set it to
//      `false` on a shard which wants its cores playable.
//
// Providers are resolved as `<modDir>/<provide>.ts` or `<modDir>/<provide>/index.ts`; the ones
// available are `backend`, `config`, `constants`, `driver`, `game`, `main`, `processor`, `schema`,
// `storage`, `terrain` and `test`. Rules which can be added and removed without invalidating
// already-saved rooms must avoid `schema`, which changes the on-disk room blob format.
export const manifest: Manifest = {
	dependencies: [
		'xxscreeps/mods/classic',
		// The closure rule reads `sectorControl` off the world's terrain records, which this mod owns.
		'xxscreeps/mods/modern/sector',
	],
	provides: [ 'config', 'main', 'processor', 'test' ],
	types,
};
