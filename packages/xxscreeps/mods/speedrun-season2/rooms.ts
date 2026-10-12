/** The only initial spawn room for season 2; enforcement is added in step 4. */
export const season2SpawnRoom = 'E3N3';

/** Precisely the 81 season-2 rooms; highways and all other sectors are excluded. */
export function isSeason2Room(name: string | undefined): boolean {
	return name?.length === 4 && /^E[1-9]N[1-9]$/.test(name);
}

/** A shared eligibility predicate, not a registered placeSpawn hook. */
export function isSeason2SpawnRoom(name: string | undefined): boolean {
	return name === season2SpawnRoom;
}
