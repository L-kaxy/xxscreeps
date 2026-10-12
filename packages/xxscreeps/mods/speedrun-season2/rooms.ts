/** The only initial spawn room for season 2. */
export const season2SpawnRoom = 'E3N3';
export const spawnRoomError = `Season 2 initial spawn is only allowed in ${season2SpawnRoom}`;

/** Precisely the 81 season-2 rooms; highways and all other sectors are excluded. */
export function isSeason2Room(name: string | undefined): boolean {
	return name?.length === 4 && /^E[1-9]N[1-9]$/.test(name);
}

/** The eligible room within season 2. */
export function isSeason2SpawnRoom(name: string | undefined): boolean {
	return name === season2SpawnRoom;
}

/** Restrict season 2 only; every other block keeps its existing placeSpawn rules. */
export function allowsInitialSpawn(name: string | undefined): boolean {
	return !isSeason2Room(name) || isSeason2SpawnRoom(name);
}
