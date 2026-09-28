import type { JSONSchemaType } from 'ajv';
import type { Database } from 'xxscreeps/engine/db/index.js';
import { hooks, makeValidatedQueryRoute } from 'xxscreeps/backend/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { Fn } from 'xxscreeps/functional/fn.js';
import { raceBrackets, readLeaderboard, readPlayerBrackets, readPlayerRecords, readRacing } from './race.js';

// The read side of the race pages, three endpoints:
//
//    GET /api/speedrun/leaderboard?bracket=20000&offset=0&limit=10
//
//        One page of a bracket: one row per player holding their best result, ordered by that result
//        and ranked zero-based. `record` is what the result looked like — level, progress,
//        progressTotal, the room, the tick it was taken and how long the run had been going — and
//        `users` carries the referenced players, as the client reads them by id.
//
//    GET /api/speedrun/records/<userId>[?bracket=20000]
//
//        Every result that player holds, best first within each bracket, for the row the list page
//        links to. `brackets` summarises the same thing: which brackets they have results in and
//        what their best is in each. A `rank` is their standing among every run of that bracket, so
//        an older run keeps the place it earned.
//
//    GET /api/speedrun/racing
//
//        The runs in progress. Nothing is stored until a bracket comes due, so each entry is read out
//        of its room as the request arrives and `left` counts down the ticks to each remaining
//        bracket. A run whose room is gone is dropped as it is read.
//
// `record.at` is the timestamp the result entered the board, which is what a "recorded at" column
// shows; `elapsed` is `record.tick - record.startedTick`, i.e. a tick count rather than wall time.

/** Stands in for a player who has since been deleted, matching the leaderboard's tombstone. */
const deletedUser = { badge: null, username: '[deleted]' };

/** The players a response references, keyed by id, as the client indexes them. */
async function usersOf(db: Database, userIds: readonly string[]) {
	return Object.fromEntries(await Fn.mapAwait(userIds, async user => {
		const info = await User.loadBackendUserInfo(db, user);
		return [ user, { _id: user, ...info ?? deletedUser } ] as const;
	}));
}

interface LeaderboardQuery {
	bracket?: number;
	limit?: number;
	offset?: number;
}

const leaderboardSchema: JSONSchemaType<LeaderboardQuery> = {
	type: 'object',
	properties: {
		bracket: { type: 'integer', nullable: true },
		limit: { type: 'integer', minimum: 1, maximum: 100, nullable: true },
		offset: { type: 'integer', minimum: 0, nullable: true },
	},
	required: [],
};

hooks.register('route', {
	path: '/api/speedrun/leaderboard',

	execute: makeValidatedQueryRoute(leaderboardSchema, async context => {
		const { bracket = raceBrackets()[0], limit = 10, offset = 0 } = context.request.query;
		if (bracket === undefined) {
			// No bracket is configured, so nothing was ever recorded.
			return { ok: 1, brackets: [], count: 0, list: [], users: {} };
		}
		const { count, list } = await readLeaderboard(context.shard, bracket, offset, limit);
		return {
			ok: 1,
			bracket,
			brackets: raceBrackets(),
			count,
			list,
			users: await usersOf(context.db, list.map(entry => entry.user)),
		};
	}),
});

interface RecordsQuery {
	bracket?: number;
}

const recordsSchema: JSONSchemaType<RecordsQuery> = {
	type: 'object',
	properties: {
		bracket: { type: 'integer', nullable: true },
	},
	required: [],
};

hooks.register('route', {
	path: '/api/speedrun/records/:user',

	execute: makeValidatedQueryRoute(recordsSchema, async context => {
		const user = context.params.user;
		if (user === undefined) {
			return { error: 'Result not found' };
		}
		const { bracket } = context.request.query;
		const overview = await readPlayerBrackets(context.shard, user);
		const list = await readPlayerRecords(context.shard, user, bracket === undefined
			? overview.map(entry => entry.bracket)
			: [ bracket ]);
		const info = await User.loadBackendUserInfo(context.db, user);
		return {
			ok: 1,
			user,
			username: info?.username ?? null,
			badge: info?.badge ?? null,
			brackets: overview,
			list,
		};
	}),
});

hooks.register('route', {
	path: '/api/speedrun/racing',

	execute: async context => {
		// The tick is read rather than taken from the backend's cached one, since the rooms the board
		// reads are read at it.
		const stored = await context.shard.data.get('time');
		const time = stored === null ? context.shard.time : Number(stored);
		const list = await readRacing(context.shard, time);
		return {
			ok: 1,
			brackets: raceBrackets(),
			time,
			list,
			users: await usersOf(context.db, list.map(entry => entry.user)),
		};
	},
});
