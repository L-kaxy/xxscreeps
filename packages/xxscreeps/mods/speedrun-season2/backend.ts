import { hooks } from 'xxscreeps/backend/index.js';
import { allowsInitialSpawn, spawnRoomError } from './rooms.js';

// Chain the already registered vanilla route, rather than registering a competing endpoint.
// Refuse before it queues an intent or writes lastSpawnTime. All vanilla validation, presence,
// occupancy and cooldown checks still run for E3N3 and rooms outside this season.
const placeSpawn = [ ...hooks.map('route') ].find(route => route.path === '/api/game/place-spawn' && route.method === 'post');
if (!placeSpawn) {
	throw new Error('Season 2 requires the original place-spawn route');
}
const execute = placeSpawn.execute;
placeSpawn.execute = context => {
	const body = context.request.body;
	if (typeof body === 'object' && body !== null && 'room' in body
		&& typeof body.room === 'string' && !allowsInitialSpawn(body.room) && context.state.userId != null) {
		return { error: spawnRoomError };
	}
	return execute(context);
};
