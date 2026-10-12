/** Season 1 owns precisely these 81 rooms, not the highways or any other sector. */
export function isSpeedrunRoom(name: string | undefined): boolean {
	return name?.length === 4 && /^W[1-9]N[1-9]$/.test(name);
}
