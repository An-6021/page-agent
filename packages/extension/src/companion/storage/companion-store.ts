import {
	type CompanionConnectionState,
	type CompanionStorageState,
	type CompanionTaskStatus,
	DEFAULT_COMPANION_STORAGE_STATE,
	companionConnectionStates,
	companionTaskStatuses,
} from '@/types/companion'

import { COMPANION_STORAGE_KEYS } from './keys'

function isCompanionConnectionState(value: unknown): value is CompanionConnectionState {
	return (
		typeof value === 'string' &&
		companionConnectionStates.includes(value as CompanionConnectionState)
	)
}

function isCompanionTaskStatus(value: unknown): value is CompanionTaskStatus {
	return typeof value === 'string' && companionTaskStatuses.includes(value as CompanionTaskStatus)
}

function normalizeCompanionStorageState(
	value: Partial<Record<keyof CompanionStorageState, unknown>>
): CompanionStorageState {
	return {
		companionEnabled:
			typeof value.companionEnabled === 'boolean'
				? value.companionEnabled
				: DEFAULT_COMPANION_STORAGE_STATE.companionEnabled,
		companionServerUrl:
			typeof value.companionServerUrl === 'string' && value.companionServerUrl.trim().length > 0
				? value.companionServerUrl
				: DEFAULT_COMPANION_STORAGE_STATE.companionServerUrl,
		companionPairToken:
			typeof value.companionPairToken === 'string' || value.companionPairToken === null
				? value.companionPairToken
				: DEFAULT_COMPANION_STORAGE_STATE.companionPairToken,
		companionConnectionState: isCompanionConnectionState(value.companionConnectionState)
			? value.companionConnectionState
			: DEFAULT_COMPANION_STORAGE_STATE.companionConnectionState,
		companionCurrentTaskId:
			typeof value.companionCurrentTaskId === 'string' || value.companionCurrentTaskId === null
				? value.companionCurrentTaskId
				: DEFAULT_COMPANION_STORAGE_STATE.companionCurrentTaskId,
		companionCurrentTaskStatus:
			value.companionCurrentTaskStatus === null ||
			isCompanionTaskStatus(value.companionCurrentTaskStatus)
				? value.companionCurrentTaskStatus
				: DEFAULT_COMPANION_STORAGE_STATE.companionCurrentTaskStatus,
		companionLastError:
			typeof value.companionLastError === 'string' || value.companionLastError === null
				? value.companionLastError
				: DEFAULT_COMPANION_STORAGE_STATE.companionLastError,
		companionLastSeenAt:
			typeof value.companionLastSeenAt === 'number' || value.companionLastSeenAt === null
				? value.companionLastSeenAt
				: DEFAULT_COMPANION_STORAGE_STATE.companionLastSeenAt,
	}
}

function omitUndefinedFields<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)
	) as Partial<T>
}

export async function getCompanionStorageState(): Promise<CompanionStorageState> {
	const result = (await chrome.storage.local.get(
		COMPANION_STORAGE_KEYS as unknown as string[]
	)) as Partial<Record<keyof CompanionStorageState, unknown>>

	return normalizeCompanionStorageState(result)
}

export async function ensureCompanionStorageDefaults(): Promise<CompanionStorageState> {
	const state = await getCompanionStorageState()
	const patch: Partial<CompanionStorageState> = {}

	for (const key of COMPANION_STORAGE_KEYS) {
		const defaultValue = DEFAULT_COMPANION_STORAGE_STATE[key]
		const currentValue = state[key]

		if (currentValue !== defaultValue) continue

		const result = await chrome.storage.local.get(key)
		if (result[key] !== undefined) continue

		patch[key] = defaultValue
	}

	if (Object.keys(patch).length > 0) {
		await chrome.storage.local.set(patch)
	}

	return state
}

export async function updateCompanionStorageState(
	patch: Partial<CompanionStorageState>
): Promise<CompanionStorageState> {
	const normalizedPatch = omitUndefinedFields(patch)

	if (Object.keys(normalizedPatch).length === 0) {
		return getCompanionStorageState()
	}

	await chrome.storage.local.set(normalizedPatch)
	return getCompanionStorageState()
}

export async function setCompanionConnectionState(
	state: CompanionConnectionState,
	options: {
		lastError?: string | null
		lastSeenAt?: number | null
	} = {}
): Promise<CompanionStorageState> {
	const patch: Partial<CompanionStorageState> = {
		companionConnectionState: state,
	}

	if (options.lastError !== undefined) {
		patch.companionLastError = options.lastError
	}

	if (options.lastSeenAt !== undefined) {
		patch.companionLastSeenAt = options.lastSeenAt
	} else if (state === 'connected') {
		patch.companionLastSeenAt = Date.now()
	}

	return updateCompanionStorageState(patch)
}

export async function setCompanionTaskState(
	taskId: string | null,
	taskStatus: CompanionTaskStatus | null
): Promise<CompanionStorageState> {
	return updateCompanionStorageState({
		companionCurrentTaskId: taskId,
		companionCurrentTaskStatus: taskStatus,
	})
}
