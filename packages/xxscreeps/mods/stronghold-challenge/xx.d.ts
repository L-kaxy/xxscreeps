declare module 'xxscreeps:mods/game' {
	import type { ChallengeRoomSchema } from 'xxscreeps/mods/stronghold-challenge/run-schema.js';
	import type { ChallengePairRoomSchema } from 'xxscreeps/mods/stronghold-challenge/schema.js';

	interface RoomSchema { strongholdChallenge: [ ChallengeRoomSchema, ChallengePairRoomSchema ] }
}

declare module 'xxscreeps:mods/processor' {
	import type { ChallengeIntents } from 'xxscreeps/mods/stronghold-challenge/processor.js';

	interface Intent { strongholdChallenge: ChallengeIntents }
}
