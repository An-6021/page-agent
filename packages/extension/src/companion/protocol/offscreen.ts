import type {
	CompanionRunRequestPayload,
	CompanionStatusRequestPayload,
	CompanionStopRequestPayload,
} from '@/companion/protocol/messages'
import type { CompanionTaskSnapshot } from '@/types/companion'

export const COMPANION_OFFSCREEN_MESSAGE_TYPE = 'COMPANION_OFFSCREEN'
export const COMPANION_OFFSCREEN_TARGET = 'companion-offscreen'
export const COMPANION_OFFSCREEN_DOCUMENT_PATH = 'offscreen.html'

export const companionOffscreenActions = ['ping', 'run', 'status', 'stop'] as const

export type CompanionOffscreenAction = (typeof companionOffscreenActions)[number]

export const companionOffscreenErrorCodes = [
	'invalid_payload',
	'task_conflict',
	'task_not_found',
	'execution_error',
] as const

export type CompanionOffscreenErrorCode = (typeof companionOffscreenErrorCodes)[number]

export interface CompanionOffscreenRequestPayloadMap {
	ping: undefined
	run: CompanionRunRequestPayload
	status: CompanionStatusRequestPayload
	stop: CompanionStopRequestPayload
}

export interface CompanionOffscreenRequest<
	TAction extends CompanionOffscreenAction = CompanionOffscreenAction,
> {
	type: typeof COMPANION_OFFSCREEN_MESSAGE_TYPE
	target: typeof COMPANION_OFFSCREEN_TARGET
	action: TAction
	payload?: CompanionOffscreenRequestPayloadMap[TAction]
}

export interface CompanionOffscreenResponse<
	TAction extends CompanionOffscreenAction = CompanionOffscreenAction,
> {
	ok: boolean
	target: typeof COMPANION_OFFSCREEN_TARGET
	action: TAction
	ready: boolean
	timestamp: number
	task?: CompanionTaskSnapshot
	accepted?: boolean
	error?: string
	code?: CompanionOffscreenErrorCode
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOffscreenAction(value: unknown): value is CompanionOffscreenAction {
	return (
		typeof value === 'string' &&
		companionOffscreenActions.includes(value as CompanionOffscreenAction)
	)
}

function isOffscreenErrorCode(value: unknown): value is CompanionOffscreenErrorCode {
	return (
		typeof value === 'string' &&
		companionOffscreenErrorCodes.includes(value as CompanionOffscreenErrorCode)
	)
}

function isTaskSnapshot(value: unknown): value is CompanionTaskSnapshot {
	if (!isPlainObject(value)) return false

	return (
		(value.taskId === null || typeof value.taskId === 'string') &&
		typeof value.status === 'string' &&
		(value.lastError === undefined ||
			value.lastError === null ||
			typeof value.lastError === 'string') &&
		(value.lastSeenAt === undefined ||
			value.lastSeenAt === null ||
			typeof value.lastSeenAt === 'number')
	)
}

export function createCompanionOffscreenPingRequest(): CompanionOffscreenRequest<'ping'> {
	return {
		type: COMPANION_OFFSCREEN_MESSAGE_TYPE,
		target: COMPANION_OFFSCREEN_TARGET,
		action: 'ping',
	}
}

export function createCompanionOffscreenRunRequest(
	payload: CompanionRunRequestPayload
): CompanionOffscreenRequest<'run'> {
	return {
		type: COMPANION_OFFSCREEN_MESSAGE_TYPE,
		target: COMPANION_OFFSCREEN_TARGET,
		action: 'run',
		payload,
	}
}

export function createCompanionOffscreenStatusRequest(
	payload: CompanionStatusRequestPayload = {}
): CompanionOffscreenRequest<'status'> {
	return {
		type: COMPANION_OFFSCREEN_MESSAGE_TYPE,
		target: COMPANION_OFFSCREEN_TARGET,
		action: 'status',
		payload,
	}
}

export function createCompanionOffscreenStopRequest(
	payload: CompanionStopRequestPayload = {}
): CompanionOffscreenRequest<'stop'> {
	return {
		type: COMPANION_OFFSCREEN_MESSAGE_TYPE,
		target: COMPANION_OFFSCREEN_TARGET,
		action: 'stop',
		payload,
	}
}

export function isCompanionOffscreenRequest(value: unknown): value is CompanionOffscreenRequest {
	if (!isPlainObject(value)) return false

	return (
		value.type === COMPANION_OFFSCREEN_MESSAGE_TYPE &&
		value.target === COMPANION_OFFSCREEN_TARGET &&
		isOffscreenAction(value.action)
	)
}

export function isCompanionOffscreenResponse(value: unknown): value is CompanionOffscreenResponse {
	if (!isPlainObject(value)) return false

	return (
		typeof value.ok === 'boolean' &&
		value.target === COMPANION_OFFSCREEN_TARGET &&
		isOffscreenAction(value.action) &&
		typeof value.ready === 'boolean' &&
		typeof value.timestamp === 'number' &&
		(value.task === undefined || isTaskSnapshot(value.task)) &&
		(value.accepted === undefined || typeof value.accepted === 'boolean') &&
		(value.error === undefined || typeof value.error === 'string') &&
		(value.code === undefined || isOffscreenErrorCode(value.code))
	)
}
