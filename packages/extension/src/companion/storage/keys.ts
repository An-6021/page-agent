export const COMPANION_STORAGE_KEYS = [
	'companionEnabled',
	'companionPairToken',
	'companionConnectionState',
	'companionCurrentTaskId',
	'companionCurrentTaskStatus',
	'companionLastError',
	'companionLastSeenAt',
] as const

export type CompanionStorageKey = (typeof COMPANION_STORAGE_KEYS)[number]
