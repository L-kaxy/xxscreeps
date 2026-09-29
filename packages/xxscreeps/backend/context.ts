import type { World } from 'xxscreeps/game/map.js';
import { config } from 'xxscreeps/config/index.js';
import { Database, Shard } from 'xxscreeps/engine/db/index.js';
import { AsyncDisposableResource } from 'xxscreeps/utility/utility.js';

export class BackendContext extends AsyncDisposableResource {
	readonly db;
	readonly shard;
	// Fork: not readonly -- `reloadWorld` swaps it in place when `manage game reload-terrain` asks
	// for it. Caches downstream are keyed by this object, so replacing it drops them.
	world: World;
	readonly accessibleRooms;

	private constructor(disposable: AsyncDisposableStack, db: Database, shard: Shard, world: World, accessibleRooms: Set<string>) {
		super(disposable);
		this.db = db;
		this.shard = shard;
		this.world = world;
		this.accessibleRooms = accessibleRooms;
	}

	static async connect() {
		// Connect to services
		await using disposable = new AsyncDisposableStack();
		const db = disposable.use(await Database.connect());
		const shard = disposable.use(await Shard.connect(db, config.shards[0]!.name));
		const world = await shard.loadWorld();
		const rooms = await shard.data.sMembers('rooms');
		const context = new BackendContext(disposable.move(), db, shard, world, new Set(rooms));
		return context;
	}

	/** Fork: re-read the terrain blob. Terrain is an input read once at boot, so a world edited
	 * while the server runs is only served after this -- `manage game reload-terrain` calls it. */
	async reloadWorld() {
		this.world = await this.shard.loadWorld();
		return this.world;
	}
}
