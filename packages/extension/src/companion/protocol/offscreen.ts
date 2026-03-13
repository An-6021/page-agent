export const COMPANION_OFFSCREEN_MESSAGE_TYPE = 'COMPANION_OFFSCREEN'
export const COMPANION_OFFSCREEN_TARGET = 'companion-offscreen'
export const COMPANION_OFFSCREEN_DOCUMENT_PATH = 'offscreen.html'

export const companionOffscreenActions = ['ping'] as const

export type CompanionOffscreenAction = (typeof companionOffscreenActions)[number]

export interface CompanionOffscreenRequest {
	type: typeof COMPANION_OFFSCREEN_MESSAGE_TYPE
	target: typeof COMPANION_OFFSCREEN_TARGET
	action: CompanionOffscreenAction
}

export interface CompanionOffscreenResponse {
	ok: boolean
	target: typeof COMPANION_OFFSCREEN_TARGET
	action: CompanionOffscreenAction
	ready: boolean
	timestamp: number
	error?: string
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createCompanionOffscreenPingRequest(): CompanionOffscreenRequest {
	return {
		type: COMPANION_OFFSCREEN_MESSAGE_TYPE,
		target: COMPANION_OFFSCREEN_TARGET,
		action: 'ping',
	}
}

export function isCompanionOffscreenResponse(value: unknown): value is CompanionOffscreenResponse {
	if (!isPlainObject(value)) return false

	return (
		value.ok !== undefined &&
		value.target === COMPANION_OFFSCREEN_TARGET &&
		value.action === 'ping' &&
		typeof value.ready === 'boolean' &&
		typeof value.timestamp === 'number' &&
		(value.error === undefined || typeof value.error === 'string')
	)
}
