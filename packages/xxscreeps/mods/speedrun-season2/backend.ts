import type { JSONSchemaType } from 'ajv';
import { hooks, makeValidatedPayloadRoute } from 'xxscreeps/backend/index.js';
import { acquireCleanup, blocksSpawn, cleanupSpawnError } from './respawn.js';
import { allowsInitialSpawn, spawnRoomError } from './rooms.js';
import './leaderboard-backend.js';

interface PlaceSpawnRequest {
	name: string;
	room: string;
	x: number;
	y: number;
}

// Match the vanilla payload locally without exporting or modifying classic's private schema.
// makeValidatedPayloadRoute retains vanilla coordinate coercion and validation-before-auth.
const placeSpawnBodyRequestSchema: JSONSchemaType<PlaceSpawnRequest> = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		room: { type: 'string' },
		x: { type: 'number' },
		y: { type: 'number' },
	},
	required: [ 'name', 'room', 'x', 'y' ],
};

// Chain the already registered vanilla route, rather than registering a competing endpoint.
// Refuse before it queues an intent or writes lastSpawnTime. All vanilla validation, presence,
// occupancy and cooldown checks still run for E3N3 and rooms outside this season.
const placeSpawn = [ ...hooks.map('route') ].find(route => route.path === '/api/game/place-spawn' && route.method === 'post');
if (!placeSpawn) {
	throw new Error('Season 2 requires the original place-spawn route');
}
const execute = placeSpawn.execute;
// Validate the vanilla-shaped payload (including coordinate coercion) before authentication.
// The original executor still performs its own validation and all gameplay checks.
const guarded = makeValidatedPayloadRoute(placeSpawnBodyRequestSchema, async context => {
	// Validation narrows this same Koa instance; the router generic itself is invariant.
	const originalContext = context as unknown as Parameters<typeof execute>[0];
	const { userId } = context.state;
	if (userId == null) {
		return execute(originalContext);
	}
	await using handle = await acquireCleanup(context.shard);
	if (blocksSpawn(handle.job, userId, context.request.body.room)) {
		return { error: cleanupSpawnError };
	}
	return await execute(originalContext);
});
placeSpawn.execute = context => {
	const body = context.request.body;
	if (typeof body === 'object' && body !== null && 'room' in body
		&& typeof body.room === 'string' && !allowsInitialSpawn(body.room) && context.state.userId != null) {
		return { error: spawnRoomError };
	}
	return guarded(context);
};
