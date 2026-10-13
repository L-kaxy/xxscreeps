import type { Drawing } from './drawing.js';
import type { Database } from 'xxscreeps/engine/db/index.js';
import type { Badge } from 'xxscreeps/engine/db/user/badge.js';
import { config } from 'xxscreeps/config/index.js';
import { KeyvalScript } from 'xxscreeps/engine/db/storage/script.js';
import * as Badges from 'xxscreeps/engine/db/user/badge.js';
import * as User from 'xxscreeps/engine/db/user/index.js';
import { compileDrawing, defaultLimits } from './drawing.js';

type PublishedBadge = ReturnType<typeof compileDrawing>['badge'];
export interface BadgeState {
	schemaVersion: 1;
	version: number;
	blocked: boolean;
	draft: Drawing | null;
	published: PublishedBadge | null;
	updatedAt: number;
	lastSavedAt: number | null;
	moderation: { actor: string; action: ModerationAction; at: number } | null;
}
export type ModerationAction = 'reset' | 'block' | 'unblock';

export class BadgeError extends Error {
	readonly status;
	readonly code;
	readonly retryAfter;

	constructor(status: number, code: string, message: string, retryAfter = 0) {
		super(message);
		this.status = status;
		this.code = code;
		this.retryAfter = retryAfter;
	}
}

export const stateKey = (user: string) => `custom-badge/user/${user}`;
export const settings = () => ({
	enabled: config.customBadge?.enabled ?? true,
	maxShapes: config.customBadge?.maxShapes ?? defaultLimits.maxShapes,
	maxPathLength: config.customBadge?.maxPathLength ?? defaultLimits.maxPathLength,
	saveCooldownSeconds: config.customBadge?.saveCooldownSeconds ?? 10,
	adminUsers: config.customBadge?.adminUsers ?? [],
});

export const defaultBadge: Badges.UserBadge = {
	type: 1, param: 0, flip: false,
	color1: '#15232e', color2: '#55d6be', color3: '#f5d58a',
};

const emptyState = (): BadgeState => ({
	schemaVersion: 1, version: 0, blocked: false, draft: null, published: null,
	updatedAt: 0, lastSavedAt: null, moderation: null,
});

function checkUserId(user: string) {
	if (user.length < 1 || user.length > 64 || /[^a-f0-9]/.test(user) || Object.hasOwn(User.npcUsers, user)) {
		throw new BadgeError(400, 'invalid_user', '玩家 ID 不合法');
	}
}

async function load(db: Database, user: string) {
	checkUserId(user);
	const [ raw, info ] = await Promise.all([
		db.data.get(stateKey(user)),
		db.data.hmGet(User.infoKey(user), [ 'username', 'badge' ]),
	]);
	if (info.username == null) {
		throw new BadgeError(404, 'unknown_user', '玩家不存在');
	}
	return {
		raw, rawBadge: info.badge ?? null, username: info.username,
		state: raw === null ? emptyState() : JSON.parse(raw) as BadgeState,
	};
}

/** Both writes commit together. The original badge is also compared because other callers can
 * change it without knowing about this mod. A failed check writes nothing, including grants. */
const commitScript = new KeyvalScript<number, [ string, string ], [ string, string, string, string, number ]>(
	(store, [ stateKey, userKey ], [ oldState, oldBadge, nextState, nextBadge, writeBadge ]) => {
		if (store.hGet(userKey, 'username') === null) {
			return -1;
		}
		if ((store.get(stateKey) ?? '') !== oldState || (store.hGet(userKey, 'badge') ?? '') !== oldBadge) {
			return 0;
		}
		store.set(stateKey, nextState);
		if (writeBadge) {
			store.hSet(userKey, 'badge', nextBadge);
		}
		return 1;
	}, {
		redis: `
if not redis.call('HGET', KEYS[2], 'username') then return -1 end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] or
   (redis.call('HGET', KEYS[2], 'badge') or '') ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[3])
if ARGV[5] == '1' then redis.call('HSET', KEYS[2], 'badge', ARGV[4]) end
return 1`,
	},
);

type Snapshot = Awaited<ReturnType<typeof load>>;

function checkVersion(state: BadgeState, version: number) {
	if (!Number.isSafeInteger(version) || version < 0) {
		throw new BadgeError(400, 'invalid_version', '版本号不合法');
	}
	if (state.version !== version || version === Number.MAX_SAFE_INTEGER) {
		throw new BadgeError(409, 'conflict', '头像已在其他窗口被修改，请重新载入后再保存');
	}
}

async function commit(db: Database, user: string, snapshot: Snapshot, next: BadgeState, badge?: Badge) {
	next.version = snapshot.state.version + 1;
	const result = await db.data.eval(commitScript, [ stateKey(user), User.infoKey(user) ], [
		snapshot.raw ?? '', snapshot.rawBadge ?? '', JSON.stringify(next),
		badge === undefined ? '' : JSON.stringify(badge), badge === undefined ? 0 : 1,
	]);
	if (result !== 1) {
		throw new BadgeError(result === -1 ? 404 : 409, 'conflict', '账号或头像已变化，请重新载入');
	}
	return { version: next.version, updatedAt: next.updatedAt };
}

export async function readSelf(db: Database, user: string) {
	const { state, username, rawBadge } = await load(db, user);
	return {
		userId: user, username, ...state,
		badge: rawBadge === null ? null : JSON.parse(rawBadge) as Badge,
		isAdmin: settings().adminUsers.includes(user),
	};
}

export async function saveDrawing(db: Database, user: string, version: number, value: unknown, publish: boolean, now = Date.now()) {
	const options = settings();
	if (!options.enabled) {
		throw new BadgeError(403, 'disabled', '服务器已暂停自定义头像保存');
	}
	const snapshot = await load(db, user);
	checkVersion(snapshot.state, version);
	if (snapshot.state.blocked) {
		throw new BadgeError(403, 'blocked', '此账号的自定义头像功能已被管理员禁用');
	}
	const previous = snapshot.state.lastSavedAt;
	const wait = previous === null ? 0 : previous + options.saveCooldownSeconds * 1000 - now;
	if (wait > 0) {
		throw new BadgeError(429, 'cooldown', '保存过于频繁，请稍后重试', Math.ceil(wait / 1000));
	}
	const { drawing, badge } = compileDrawing(value, options);
	// The compiler creates the entire payload, including the only two permitted path attributes.
	// Grant + account badge must not be saved separately: a crash would otherwise split the pair.
	return commit(db, user, snapshot, {
		...snapshot.state, draft: drawing, updatedAt: now, lastSavedAt: now,
		published: publish ? badge : snapshot.state.published,
	}, publish ? badge : undefined);
}

export async function resetSelf(db: Database, user: string, version: number) {
	const snapshot = await load(db, user);
	checkVersion(snapshot.state, version);
	return commit(db, user, snapshot, {
		...snapshot.state, published: null, updatedAt: Date.now(),
	}, defaultBadge);
}

/** Called instead of the original route while this mod is loaded. Authorization is still core's,
 * but the grant snapshot is compared at commit, so in-flight requests cannot undo moderation. */
export async function saveLegacyBadge(db: Database, user: string, value: unknown) {
	const snapshot = await load(db, user);
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		throw new BadgeError(400, 'invalid_badge', '头像数据不合法');
	}
	let validated: Badge;
	try {
		validated = await Badges.validate(db, user, { ...value });
	} catch {
		throw new BadgeError(400, 'invalid_badge', '头像数据不合法或图案未授权');
	}
	const { color1, color2, color3, flip } = validated;
	const badge: Badge = Badges.isUserBadge(validated)
		? { color1, color2, color3, flip, type: validated.type, param: validated.param }
		: { color1, color2, color3, flip, type: validated.type };
	if (Badges.isUserBadge(badge) && (!Number.isInteger(badge.type) || !Number.isFinite(badge.param))) {
		throw new BadgeError(400, 'invalid_badge', '头像类型必须是原版整数编号');
	}
	await commit(db, user, snapshot, { ...snapshot.state, updatedAt: Date.now() }, badge);
}

export function checkAdmin(actor: string) {
	if (!settings().adminUsers.includes(actor)) {
		throw new BadgeError(403, 'forbidden', '没有头像管理权限');
	}
}

export async function moderate(db: Database, actor: string, user: string, version: number, action: ModerationAction) {
	checkAdmin(actor);
	if (![ 'reset', 'block', 'unblock' ].includes(action)) {
		throw new BadgeError(400, 'invalid_action', '管理操作不合法');
	}
	const snapshot = await load(db, user);
	checkVersion(snapshot.state, version);
	const now = Date.now();
	const reset = action !== 'unblock';
	const next = {
		...snapshot.state,
		blocked: action === 'reset' ? snapshot.state.blocked : action === 'block',
		draft: reset ? null : snapshot.state.draft,
		published: reset ? null : snapshot.state.published,
		updatedAt: now, moderation: { actor, action, at: now },
	};
	return commit(db, user, snapshot, next, reset ? defaultBadge : undefined);
}

Badges.hooks.register('symbols', async (db, user) => {
	if (!settings().enabled) {
		return [];
	}
	const raw = await db.data.get(stateKey(user));
	const state = raw === null ? null : JSON.parse(raw) as BadgeState;
	return state?.published && !state.blocked ? [ state.published.type ] : [];
});

User.hooks.register('remove', async (db, user) => { await db.data.del(stateKey(user)); });
