import type { CleanupJob } from './respawn.js';
import type { ProcessorContext } from 'xxscreeps/engine/processor/room.js';
import { me, runAsUser } from 'xxscreeps/game/index.js';
import { acquireCleanup } from './respawn.js';

type Action = { user: string; apply: (job: CleanupJob | undefined) => void | Promise<void> };
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
		const pending: Promise<void>[] = [];
		try {
			for (const callback of actions) {
				const task = runAsUser(callback.user, () => callback.apply(handle.job));
				if (task !== undefined) {
					pending.push(task);
				}
			}
		} finally {
			batches.delete(context);
			context.task(async function() {
				try {
					// Only block-local storage writes belong here, never account-locking race tasks.
					await Promise.all(pending);
				} finally {
					await handle[Symbol.asyncDispose]();
				}
			}());
		}
	});
}
