import type { JSONSchemaType } from 'ajv';
import type { Database } from 'xxscreeps/engine/db/index.js';
import { bindRenderer, hooks, makeValidatedQueryRoute } from 'xxscreeps/backend/index.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { tickSpeed } from 'xxscreeps/engine/service/tick.js';
import { StructureSpawn } from 'xxscreeps/mods/classic/spawn/spawn.js';
import { Structure } from 'xxscreeps/mods/classic/structure/structure.js';
import { StructureInvaderCore } from 'xxscreeps/mods/modern/stronghold/invader-core.js';
import * as C from 'xxscreeps:mods/constants';
import { challengePage } from './page.js';
import { challengeRankingKeys, parseChallengeRecord } from './ranking.js';
import { readRankedRuns, readRunRanking } from './runs.js';
import { getChallengeSpawnEffect } from './spawn-effects.js';
import './race.js';

interface RenderedEffect {
	effect?: number;
	power?: number;
	level?: number;
	endTime?: number;
	duration?: number;
}
interface RenderedChallengeObject {
	_id: string;
	type: string;
	x: number;
	y: number;
	effects?: readonly RenderedEffect[];
}

function renderChallengeEffects(structure: Structure, rendered: RenderedChallengeObject) {
	if (structure.room['#challengePair'] === undefined) {
		return rendered;
	}
	const effects = [ ...rendered.effects ?? [] ];
	const permanent = structure instanceof StructureSpawn ? getChallengeSpawnEffect(structure) : undefined;
	if (permanent !== undefined && !effects.some(effect => effect.power === permanent.effect)) {
		effects.push({ power: permanent.effect, level: permanent.level });
	}
	const collapseTime = structure['#collapseTime'];
	if (collapseTime > 0 && !effects.some(effect => effect.effect === C.EFFECT_COLLAPSE_TIMER)) {
		effects.push({ effect: C.EFFECT_COLLAPSE_TIMER, endTime: collapseTime, duration: C.STRONGHOLD_DECAY_TICKS });
	}
	return { ...rendered, ...effects.length > 0 && { effects } };
}

bindRenderer(Structure, (structure, next) => renderChallengeEffects(structure, next()));
// The stock core renderer replaces its inherited effects while deploying. Compose once more on
// the core so a paired room retains both its native deployment timer and its challenge deadline.
bindRenderer(StructureInvaderCore, (core, next) => renderChallengeEffects(core, next()));

interface RankingQuery {
	limit?: number;
	offset?: number;
}

const rankingSchema: JSONSchemaType<RankingQuery> = {
	type: 'object',
	properties: {
		limit: { type: 'integer', minimum: 1, maximum: 100, nullable: true },
		offset: { type: 'integer', minimum: 0, nullable: true },
	},
	required: [],
};

async function usersOf(db: Database, userIds: string[]) {
	return Object.fromEntries(await Promise.all([ ...new Set(userIds) ].map(async user => {
		const info = await User.loadBackendUserInfo(db, user);
		return [ user, { _id: user, ...info ?? { username: '[deleted]', badge: null } } ] as const;
	})));
}

hooks.register('route', {
	path: '/api/stronghold-challenge/leaderboard',
	execute: makeValidatedQueryRoute(rankingSchema, async context => {
		const { limit = 25, offset = 0 } = context.request.query;
		const page = await readRunRanking(context.db.data, challengeRankingKeys(context.shard.name), 'ascending', offset, limit);
		const list = page.list.map(({ fields, ...entry }) => ({
			...entry, record: fields === undefined ? undefined : parseChallengeRecord(fields),
		}));
		return { ok: 1, count: page.count, list, users: await usersOf(context.db, list.map(entry => entry.user)) };
	}),
});

hooks.register('route', {
	path: '/api/stronghold-challenge/records/:user',
	execute: async context => {
		const user = context.params.user;
		if (user === undefined) {
			return { error: 'Player not found' };
		}
		const [ info, records ] = await Promise.all([
			User.loadBackendUserInfo(context.db, user),
			readRankedRuns(context.db.data, challengeRankingKeys(context.shard.name), 'ascending', user),
		]);
		const list = records.map(({ fields, ...entry }) => ({ ...entry, record: parseChallengeRecord(fields) }));
		return { ok: 1, user, username: info?.username ?? '[deleted]', list };
	},
});

hooks.register('route', {
	path: '/api/stronghold-challenge/racing',
	execute: async context => {
		const stored = await context.shard.data.get('time');
		const time = stored === null ? context.shard.time : Number(stored);
		const active = await context.shard.data.sMembers('stronghold-challenge/active');
		const runs = await Promise.all(active.map(async user => {
			const fields = await context.shard.data.hGetAll(`stronghold-challenge/run/${user}`);
			if (fields.state !== 'running') {
				return [];
			}
			const startedTick = Number(fields.startedTick);
			const deadlineTick = Number(fields.deadlineTick);
			return [ {
				coreId: fields.coreId,
				deadlineTick,
				elapsed: time - startedTick,
				left: Math.max(0, deadlineTick - time),
				room: fields.room,
				run: Number(fields.run),
				startedTick,
				state: fields.state,
				targetRoom: fields.targetRoom,
				user,
			} ];
		}));
		const list = runs.flat().sort((left, right) => left.startedTick - right.startedTick);
		return { ok: 1, time, tickSpeed, list, users: await usersOf(context.db, list.map(entry => entry.user)) };
	},
});

hooks.register('middleware', (_koa, router) => {
	router.get([ '/stronghold-challenge', '/stronghold-challenge/' ], context => {
		context.type = 'text/html';
		context.body = challengePage;
	});
});

hooks.register('version', serverData => {
	serverData.features.push({
		name: 'stronghold-challenge',
		version: 1,
		menuData: [ {
			section: 0,
			after: 'World',
			item: {
				href: '/stronghold-challenge',
				id: 'menu-item-stronghold-challenge',
				label: 'Stronghold Challenge',
				svg: 'leaderboard',
				target: '_blank',
			},
		} ],
	});
});
