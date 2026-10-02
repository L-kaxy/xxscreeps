import type { TypeOf } from 'xxscreeps/schema/index.js';
import { registerStruct } from 'xxscreeps/engine/schema/index.js';
import { enumerated, optional, struct } from 'xxscreeps/schema/index.js';

const identity = struct({ userId: 'string', runId: 'string', startedTick: 'int32' });
const runFormat = struct(identity, {
	home: 'string',
	coreId: 'string',
	deadlineTick: 'int32',
	finishedTick: optional('int32'),
	state: enumerated('running', 'won', 'timedOut', 'abandoned'),
});

export type ChallengeRun = TypeOf<typeof runFormat>;
export type ChallengeRoomSchema = typeof roomSchema;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const roomSchema = registerStruct('Room', {
	// The home keeps the identity needed to cancel its target; the target owns the run state.
	'#challengeHomeRun': optional(identity),
	'#challengeRun': optional(runFormat),
});
