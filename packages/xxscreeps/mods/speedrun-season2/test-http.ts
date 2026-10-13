import type { Shard } from 'xxscreeps/engine/db/shard.js';
import type { Context, State } from 'xxscreeps:backend';
import * as http from 'node:http';
import Koa from 'koa';
import Router from 'koa-router';
import { VersionEndpoint } from 'xxscreeps/backend/endpoints/version.js';
import { hooks } from 'xxscreeps/backend/index.js';
import 'xxscreeps:mods/backend';

/** Temporary localhost harness using the real validators, registered page middleware and endpoints. */
export async function startBoardServer(shard: Shard, port = 0) {
	const koa = new Koa<State, Context>();
	const router = new Router<State, Context>();
	koa.use(async (context, next) => {
		context.db = shard.db;
		context.shard = shard;
		await next();
	});
	hooks.makeIterated('middleware')(koa, router);
	for (const endpoint of [ VersionEndpoint, ...hooks.map('route') ]) {
		if (endpoint.path === '/api/version' || endpoint.path.startsWith('/api/speedrun')) {
			router[endpoint.method ?? 'get'](endpoint.path, async context => {
				context.body = await endpoint.execute(context);
			});
		}
	}
	koa.use(router.routes());
	koa.use(router.allowedMethods());
	const callback = koa.callback();
	const server = http.createServer((request, response) => { void callback(request, response); });
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new Error('Missing test HTTP address');
	}
	return {
		origin: `http://127.0.0.1:${address.port}`,
		async [Symbol.asyncDispose]() {
			await new Promise<void>((resolve, reject) => {
				server.close(error => error ? reject(error) : resolve());
			});
		},
	};
}
