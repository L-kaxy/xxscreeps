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
//    - `deposits` / `powerBanks` (default `false`): the two resource generators -- `modern/deposit`
//      and `modern/powerbank` -- are stopped at their placement intent, so no new deposit or power
//      bank is ever put down. Objects already in the world keep their tick processor, their decay
//      and their schedule; nothing is written to or deleted from the world. See the second half of
//      `processor.ts`.
//
//    - `ruins` (default `false`): a destroyed structure leaves no ruin behind. Every lane which
//      puts one down -- combat and decay destruction, and the two spawn intents whose ruins carry a
//      100000/500000 tick decay -- goes through `Room['#insertObject']`, so that one method is
//      wrapped in `processor.ts` and a `Ruin` handed to it is dropped before it is queued. Nothing
//      about the room blob format changes, and the destroy event log entry is still written.
//
//    - `respawnCleanup` (default `true`): when a player respawns, the neutral structures they left
//      behind in the rooms they were using -- roads, containers, walls -- are destroyed with the
//      rest of the handover. Vanilla takes their owned objects and releases the controllers, but
//      the unowned ones carry no owner and simply stay. See `respawn.ts` for the mechanism (it
//      chains the engine's `unspawn` handler) and the guards on the rooms it applies to.
//
//    - `raceBrackets` (default `[ 20000, 40000 ]`): the tick offsets after a landing which are
//      recorded as race results. `processor.ts` chains `placeSpawn` to start a run and schedule the
//      brackets, and `main.ts` drains the schedule from the shard tick processor, so a result lands
//      whether or not the player is online. `race.ts` owns the tables (`speedrun/run`,
//      `speedrun/score`, `speedrun/rank`, `speedrun/best`, `speedrun/runs`, `speedrun/brackets`,
//      plus the shard's `speedrun/due` and `speedrun/racing`); a run only scores while its room is
//      still held at RCL 2 or above. `backend.ts` serves the three pages: a bracket's list (one row
//      per player, their best), one player's records, and the runs still in progress -- and the board
//      which reads them, `page.ts`, at `/speedrun`. The client is the official AngularJS bundle, so
//      the board is ours and the client only carries the link: a `menuData` entry on `/api/version`
//      opens it in its own tab.
//
//    - `respawnAfter` (default `40000`, i.e. the last bracket): how many ticks a run lasts before the
//      server respawns the player on its own. When the window runs out, the rooms the player is
//      present in are handed over per `unspawn` -- the same handover a respawn does, so
//      `respawnCleanup` applies -- and nothing else: no spawn is placed for them, and the next run
//      starts from the landing they make themselves. It is the shard tick processor which decides,
//      so a player who has walked away is picked up by the next round, and a run whose room was lost
//      is picked up too. Set it to `0` to leave respawns to the player.
//
//    - `claimController` (default `false`): `Creep.claimController` is refused before it records an
//      intent, so players cannot take a room. `reserveController`, `attackController` and
//      `upgradeController` are untouched, and the starting room a new player is handed goes through
//      its own `placeSpawn` intent. `game.ts` wraps the method; because a sandbox module cannot
//      reach `xxscreeps/config`, the switch rides the tick payload (`driver.ts`).
//
//    - `closeCenterNine` (default `true`): the sector cores -- each sector's center room plus its
//      eight neighbours, the same central 3x3 the vanilla server's `closeRoom` console command was
//      aimed at -- are dropped from the world's open-room list on every service start, which is
//      what `Game.map.getRoomStatus()` reports as `closed`. Nothing inside them is read or deleted,
//      and no other room is touched. See `main.ts` for the mechanism and `rooms.ts` for how the
//      rooms are picked (out of the world's own sector records, not out of room names). Set it to
//      `false` on a shard which wants its cores playable.
//
//    - `wallSectorCores` (default `true`): the nine rooms of each sector core are painted solid, and
//      so are the facing edges of the rooms around them -- a creep crossing a room border is
//      validated against the room it is leaving, so the core alone would not keep anybody out. No
//      object is read, moved or deleted and the sector record survives, so deposit and power bank
//      placement keep working. The original terrain is kept under `speedrun/terrainBackup`. See
//      `walls.ts` and the second hook in `main.ts`.
//
//    - `uniform-terrain`, a command rather than a rule -- nothing here runs on its own:
//
//         xxscreeps uniform-terrain [--shard shard] [--terrain-type 1-28] [--swamp-type 0-14]
//                 [--exits 8] [--sources 1-4] [--mineral H|O|Z|K|U|L|X] [--no-objects]
//                 [--template file.json] [--save file.json] [--dry-run] [--restore]
//
//      It overwrites every room of each sector's 9x9 interior -- everything but the core, 72 rooms of
//      the stock world -- with one generated template, so no room is a better start than another.
//      The template is `generate-room`'s own generator (`template.ts`), sharing its layout ranges,
//      with one change: every side carries the same centred opening (`--exits`) instead of the exits
//      the neighbours happen to have, so two rooms built from it share a border tile for tile and the
//      whole grid walks through. A layout which would come out in several pieces is repaired rather
//      than rerolled, so all 28 connect. Rooms around a core keep the face which looks at it shut,
//      and the highway ring is opened on the faces which look at a covered room, or the outermost
//      rooms would advertise exits the ring seals.
//
//      The objects follow the same idea. The template plans the tiles its sources, its mineral and
//      its controller go on -- off the terrain, the way `room-gen` places them, so every one of them
//      has ground beside it -- and every covered room is moved onto that plan: its own sources, ones
//      it was missing, or fewer than `--sources` asks for, its mineral with the extractor built on
//      it, and its controller. Nothing else in a room is touched; a planned tile another object
//      already stands on is nudged to the nearest free ground and the room is reported. `--no-objects`
//      writes the terrain alone. Both stores are written under the game mutex, and both are kept
//      before they are: the terrain under `speedrun/terrainBackup`, each rewritten room under
//      `speedrun/uniformRoomBackup`. `--restore` writes both back. See `uniform.ts` for the write,
//      `place.ts` for the objects and `template.ts` for the plan.
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
	provides: [ 'backend', 'config', 'driver', 'game', 'main', 'processor', 'test' ],
	types,
};
