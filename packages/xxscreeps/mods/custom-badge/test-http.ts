import type { Shard } from 'xxscreeps/engine/db/index.js';
import type { Context, State } from 'xxscreeps:backend';
import * as http from 'node:http';
import Koa from 'koa';
import bodyParser from 'koa-bodyparser';
import Router from 'koa-router';
import { authentication } from 'xxscreeps/backend/auth/index.js';
import badgeEndpoints from 'xxscreeps/backend/endpoints/user/badge.js';
import { VersionEndpoint } from 'xxscreeps/backend/endpoints/version.js';
import { hooks } from 'xxscreeps/backend/index.js';
import 'xxscreeps:mods/backend';

/** Test-only, loopback HTTP harness: real authentication, middleware, validators and storage. */
export async function startBadgeTestServer(shard: Shard) {
	const koa = new Koa<State, Context>();
	const router = new Router<State, Context>();
	koa.use(async (context, next) => {
		context.db = shard.db;
		context.shard = shard;
		try { await next(); } catch { context.status = 500; context.body = { error: 'unexpected_test_error' }; }
	});
	koa.use(bodyParser({ jsonLimit: '8mb' }));
	koa.use(authentication());
	hooks.makeIterated('middleware')(koa, router);
	for (const endpoint of [ VersionEndpoint, ...badgeEndpoints, ...hooks.map('route') ]) {
		if (endpoint.path === '/api/version' || endpoint.path === '/api/auth/signin' ||
			endpoint.path.startsWith('/api/custom-badge') || endpoint.path.startsWith('/api/user/badge')) {
			router[endpoint.method ?? 'get'](endpoint.path, async context => {
				const value = await endpoint.execute(context);
				if (value !== undefined && value !== true) { context.body = value; }
			});
		}
	}
	koa.use(router.routes());
	koa.use(router.allowedMethods());
	const callback = koa.callback();
	const server = http.createServer((request, response) => { void callback(request, response); });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') { throw new Error('Missing test address'); }
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); });
		},
	};
}
