import type { CleanupJob } from './respawn.js';
import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { me, runAsUser } from 'xxscreeps/game/index.js';
import { acquireCleanup } from './respawn.js';

type Action = { user: string; apply: (job: CleanupJob | undefined) => void };
const batches = new WeakMap<ProcessorContext, Action[]>();

/** One acquisition per task batch: flushTasks awaits every promise before running finalizers. */
export function withCleanup(context: ProcessorContext, apply: Action['apply']) {
	const action = { user: me, apply };
	const pending = batches.get(context);
	if (pending) {
		pending.push(action);
		return;
	}
	const actions = [ action ];
	batches.set(context, actions);
	context.task(acquireCleanup(context.shard), handle => {
		try {
			for (const callback of actions) {
				runAsUser(callback.user, () => callback.apply(handle.job));
			}
		} finally {
			batches.delete(context);
			context.task(handle[Symbol.asyncDispose]());
		}
	});
}
