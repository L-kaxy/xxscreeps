import { registerStruct } from 'xxscreeps/engine/schema/index.js';
import { roomNameFormat } from 'xxscreeps/game/room/name.js';
import { optional, struct } from 'xxscreeps/schema/index.js';
import './run-schema.js';

export type ChallengePairRoomSchema = typeof challengeSchema;

// Role metadata belongs to the prepared room and survives its object resets.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const challengeSchema = registerStruct('Room', {
	'#challengePair': optional(struct({ home: roomNameFormat, stronghold: roomNameFormat })),
});
