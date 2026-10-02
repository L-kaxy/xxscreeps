import type { Mutex } from 'xxscreeps/engine/db/mutex.js';
import type { KeyValProvider } from 'xxscreeps/engine/db/storage/provider.js';
import { preparedKey } from './setup.js';

export function isMainServiceEntry(command: string | undefined) {
	return command === 'main' || command === 'start' ||
		command === import.meta.resolve('xxscreeps/engine/service/main.js') ||
		command === import.meta.resolve('xxscreeps/engine/service/launcher.js');
}

/** Check readiness after acquiring main so offline preparation and startup cannot race. */
export function guardPreparedMain(mutex: Mutex, data: KeyValProvider) {
	const acquire = mutex.acquire.bind(mutex);
	mutex.acquire = async () => {
		await using disposable = new AsyncDisposableStack();
		disposable.use(await acquire());
		if (await data.get(preparedKey) !== '1') {
			throw new Error('Prepare the stronghold challenge map offline with xxscreeps prepare-stronghold before starting');
		}
		return disposable.move();
	};
	return mutex;
}
