import { Script } from 'node:vm';
import { competitionStyles } from 'xxscreeps/backend/competition-page.js';
import { speedrunPage } from 'xxscreeps/mods/speedrun/page.js';
import { assert, describe, test } from 'xxscreeps/test/index.js';
import { challengePage } from './page.js';

describe('stronghold challenge page', () => {
	test('both competition pages use the same standalone theme', () => {
		for (const page of [ challengePage, speedrunPage ]) {
			assert.ok(page.includes(competitionStyles));
			assert.match(page, /class="drawer"/);
			assert.doesNotMatch(page, /<(?:link|script)[^>]+(?:href|src)=/);
		}
	});

	test('the served inline script parses without a frontend build step', () => {
		const script = /<script>([\s\S]+?)<\/script>/.exec(challengePage)?.[1];
		assert.ok(script !== undefined);
		assert.doesNotThrow(() => new Script(script));
	});

	test('page retains accessible live status, pagination and native modal details', () => {
		assert.match(challengePage, /id="status" role="status"/);
		assert.match(challengePage, /id="previous" disabled/);
		assert.match(challengePage, /id="next" disabled/);
		assert.match(challengePage, /<dialog[^>]+aria-labelledby="detail-title"/);
		assert.match(challengePage, /<form method="dialog">/);
		assert.match(challengePage, /api\('records\/' \+ encodeURIComponent\(user\)\)/);
		assert.match(challengePage, /20000/);
	});
});
