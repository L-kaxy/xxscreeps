export interface CustomBadgeSettings {
	/** Allow publishing custom badges. Existing account badges remain visible. @default true */
	enabled?: boolean;
	/** Maximum shapes in a drawing (1–64). @default 32 */
	maxShapes?: number;
	/** Maximum combined path length (1024–131072). @default 32768 */
	maxPathLength?: number;
	/** Minimum wall-clock seconds between draft saves / publishes (0–3600). @default 10 */
	saveCooldownSeconds?: number;
	/** Account IDs allowed to reset / block / unblock custom badges. No implicit administrators. */
	adminUsers?: string[];
}

export interface CustomBadgeConfig {
	customBadge?: CustomBadgeSettings;
}

declare module 'xxscreeps/config/config.js' {
	interface Config extends CustomBadgeConfig {}
}

export const initializationDefaults = {
	customBadge: {
		enabled: true,
		maxShapes: 32,
		maxPathLength: 32768,
		saveCooldownSeconds: 10,
		adminUsers: [],
	},
} satisfies CustomBadgeConfig;
