import type { Endpoint } from 'xxscreeps/backend/index.js';
import * as fs from 'node:fs/promises';
import { hooks } from 'xxscreeps/backend/index.js';
import { config } from 'xxscreeps/config/index.js';
import { DrawingError, maxRequestBytes, object } from './drawing.js';
import { BadgeError, checkAdmin, moderate, readSelf, resetSelf, saveDrawing, saveLegacyBadge, settings } from './model.js';
import { editorPage } from './page.js';

type Context = Parameters<Endpoint['execute']>[0];

function report(context: Context, error: unknown) {
	if (error instanceof DrawingError || error instanceof BadgeError) {
		context.status = error instanceof BadgeError ? error.status : 400;
		if (error instanceof BadgeError && error.retryAfter > 0) {
			context.set('Retry-After', `${error.retryAfter}`);
		}
		return { error: error instanceof BadgeError ? error.code : 'invalid_drawing', message: error.message };
	}
	throw error;
}

function user(context: Context) {
	const id = context.state.userId;
	if (id === undefined) {
		throw new BadgeError(401, 'unauthorized', '请先登录本服账号');
	}
	return id;
}

function body(context: Context, keys: string[]) {
	if (context.is('application/json') !== 'application/json') {
		throw new BadgeError(415, 'content_type', '请使用 application/json');
	}
	const value = object(context.request.body, keys);
	if (Buffer.byteLength(JSON.stringify(value)) > maxRequestBytes) {
		throw new BadgeError(413, 'too_large', '请求不能超过 64 KiB');
	}
	return value;
}

const version = (value: unknown) => {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw new BadgeError(400, 'invalid_version', '需要非负整数版本号');
	}
	return value;
};

function route(endpoint: Endpoint) {
	hooks.register('route', {
		...endpoint,
		async execute(context) {
			context.set('Cache-Control', 'no-store');
			try {
				return await endpoint.execute(context);
			} catch (error) {
				return report(context, error);
			}
		},
	});
}

route({
	path: '/api/custom-badge/config',
	execute() {
		const { adminUsers: _adminUsers, ...options } = settings();
		return {
			ok: 1, ...options,
			auth: {
				password: [ ...hooks.map('route') ].some(route => route.path === '/api/auth/signin'),
				steam: config.backend.steamApiKey !== undefined &&
					config.mods.includes('xxscreeps/mods/backend/steam'),
			},
		};
	},
});

route({
	path: '/api/custom-badge/me',
	async execute(context) { return { ok: 1, ...await readSelf(context.db, user(context)) }; },
});

route({
	path: '/api/custom-badge/save', method: 'post',
	async execute(context) {
		const id = user(context);
		const request = body(context, [ 'version', 'drawing', 'publish' ]);
		if (typeof request.publish !== 'boolean') {
			throw new DrawingError('publish 必须是布尔值');
		}
		return { ok: 1, ...await saveDrawing(context.db, id, version(request.version), request.drawing, request.publish) };
	},
});

route({
	path: '/api/custom-badge/reset', method: 'post',
	async execute(context) {
		const id = user(context);
		const request = body(context, [ 'version' ]);
		return { ok: 1, ...await resetSelf(context.db, id, version(request.version)) };
	},
});

route({
	path: '/api/custom-badge/admin/user',
	async execute(context) {
		checkAdmin(user(context));
		const id = context.query.userId;
		if (typeof id !== 'string') {
			throw new DrawingError('需要玩家 ID');
		}
		return { ok: 1, ...await readSelf(context.db, id) };
	},
});

route({
	path: '/api/custom-badge/admin/moderate', method: 'post',
	async execute(context) {
		const actor = user(context);
		checkAdmin(actor);
		const request = body(context, [ 'userId', 'version', 'action' ]);
		if (typeof request.userId !== 'string' ||
			(request.action !== 'reset' && request.action !== 'block' && request.action !== 'unblock')) {
			throw new DrawingError('管理请求不合法');
		}
		return { ok: 1, ...await moderate(context.db, actor, request.userId, version(request.version), request.action) };
	},
});

const assets = new Map<string, Promise<string>>();

hooks.register('middleware', (koa, router) => {
	// Keep the original API and its shape. CAS against both grant and badge closes the old API's
	// validate-then-write race without changing core or making decorations depend on this mod.
	koa.use(async (context, next) => {
		if (context.path === '/api/user/badge' && context.method === 'POST') {
			try {
				const request = body(context as Context, [ 'badge' ]);
				await saveLegacyBadge(context.db, user(context as Context), request.badge);
				context.body = { ok: 1 };
			} catch (error) {
				context.body = report(context as Context, error);
			}
			context.set('Cache-Control', 'no-store');
		} else {
			await next();
		}
	});
	// A trailing slash makes all module/API URLs work beneath a same-origin reverse-proxy prefix.
	router.get('/custom-badge', async (context, next) => {
		if (context.path === '/custom-badge') { context.redirect('custom-badge/'); } else { await next(); }
	});
	router.get('/custom-badge/', context => {
		context.set('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
		context.set('Referrer-Policy', 'no-referrer');
		context.set('X-Content-Type-Options', 'nosniff');
		context.set('Cache-Control', 'no-store');
		context.type = 'html';
		context.body = editorPage;
	});
	for (const file of [ 'editor.js', 'drawing.js' ]) {
		router.get(`/custom-badge/assets/${file}`, async context => {
			let contents = assets.get(file);
			if (contents === undefined) {
				assets.set(file, contents = fs.readFile(new URL(file, import.meta.url), 'utf8'));
			}
			context.set('Cache-Control', 'no-cache');
			context.set('X-Content-Type-Options', 'nosniff');
			context.type = 'application/javascript';
			context.body = await contents;
		});
	}
});

hooks.register('version', data => {
	if (settings().enabled) {
		data.features.push({
			name: 'custom-badge', version: 1,
			menuData: [ {
				section: 0, after: 'World',
				item: {
					id: 'menu-item-custom-badge', label: 'Badge Studio', svg: 'arena', target: '_blank',
					href: `${(config.backend.assetBaseUrl ?? '').replace(/\/$/, '')}/custom-badge/`,
				},
			} ],
		});
	}
});
