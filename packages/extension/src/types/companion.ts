export const companionConnectionStates = [
	'disabled',
	'disconnected',
	'connecting',
	'connected',
	'error',
] as const

export type CompanionConnectionState = (typeof companionConnectionStates)[number]

export const companionTaskStatuses = [
	'idle',
	'queued',
	'running',
	'completed',
	'error',
	'stopped',
] as const

export type CompanionTaskStatus = (typeof companionTaskStatuses)[number]

export interface CompanionStorageState {
	companionEnabled: boolean
	companionPairToken: string | null
	companionConnectionState: CompanionConnectionState
	companionCurrentTaskId: string | null
	companionCurrentTaskStatus: CompanionTaskStatus | null
	companionLastError: string | null
	companionLastSeenAt: number | null
}

export const DEFAULT_COMPANION_STORAGE_STATE: CompanionStorageState = {
	companionEnabled: false,
	companionPairToken: null,
	companionConnectionState: 'disabled',
	companionCurrentTaskId: null,
	companionCurrentTaskStatus: null,
	companionLastError: null,
	companionLastSeenAt: null,
}
