import type {
	CompanionConnectionState,
	CompanionStorageState,
	CompanionTaskSnapshot,
	CompanionTaskStatus,
} from '@/types/companion'

export const COMPANION_PROTOCOL_VERSION = '0.1.0'

export const companionRequestTypes = ['hello', 'pair', 'run', 'status', 'stop'] as const

export type CompanionRequestType = (typeof companionRequestTypes)[number]

export const companionResponseTypes = [
	'ack',
	'status',
	'status_changed',
	'result',
	'activity',
	'error',
] as const

export type CompanionResponseType = (typeof companionResponseTypes)[number]

export const companionErrorCodes = [
	'invalid_message',
	'invalid_payload',
	'unsupported_request',
	'pairing_required',
	'pairing_mismatch',
	'not_implemented',
] as const

export type CompanionErrorCode = (typeof companionErrorCodes)[number]

export interface CompanionHelloRequestPayload {
	protocolVersion?: string
	client?: string
	instanceId?: string
}

export interface CompanionPairRequestPayload {
	pairToken: string
}

export interface CompanionRunRequestPayload {
	taskId?: string
	task: string
	llm?: Record<string, unknown>
	options?: Record<string, unknown>
}

export interface CompanionStatusRequestPayload {
	taskId?: string | null
}

export interface CompanionStopRequestPayload {
	taskId?: string | null
}

export interface CompanionRequestPayloadMap {
	hello: CompanionHelloRequestPayload
	pair: CompanionPairRequestPayload
	run: CompanionRunRequestPayload
	status: CompanionStatusRequestPayload
	stop: CompanionStopRequestPayload
}

export type CompanionRequestEnvelopeMap = {
	[K in CompanionRequestType]: {
		type: K
		requestId: string | null
		payload: CompanionRequestPayloadMap[K]
	}
}

export type CompanionRequestEnvelope =
	CompanionRequestEnvelopeMap[keyof CompanionRequestEnvelopeMap]

export interface CompanionAckPayload {
	accepted: boolean
	requestType: CompanionRequestType
	protocolVersion: string
	capabilities?: string[]
	paired?: boolean
}

export interface CompanionErrorPayload {
	code: CompanionErrorCode
	message: string
	requestType?: string
}

export interface CompanionStatusPayload {
	task: CompanionTaskSnapshot
	connectionState: CompanionConnectionState
	paired: boolean
	protocolVersion: string
}

export interface CompanionEnvelope<TType extends string, TPayload> {
	type: TType
	requestId: string | null
	payload: TPayload
}

export type ParsedCompanionRequestResult =
	| {
			ok: true
			envelope: CompanionRequestEnvelope
	  }
	| {
			ok: false
			requestId: string | null
			requestType?: string
			code: CompanionErrorCode
			message: string
	  }

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value)
}

function isRequestType(value: unknown): value is CompanionRequestType {
	return typeof value === 'string' && companionRequestTypes.includes(value as CompanionRequestType)
}

function normalizeRequestId(value: unknown): string | null {
	return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function parseHelloPayload(value: unknown): CompanionHelloRequestPayload | null {
	if (value === undefined) return {}
	if (!isPlainObject(value)) return null

	const payload: CompanionHelloRequestPayload = {}

	if (typeof value.protocolVersion === 'string') payload.protocolVersion = value.protocolVersion
	if (typeof value.client === 'string') payload.client = value.client
	if (typeof value.instanceId === 'string') payload.instanceId = value.instanceId

	return payload
}

function parsePairPayload(value: unknown): CompanionPairRequestPayload | null {
	if (!isPlainObject(value)) return null
	if (typeof value.pairToken !== 'string' || value.pairToken.trim().length === 0) return null

	return {
		pairToken: value.pairToken,
	}
}

function parseRunPayload(value: unknown): CompanionRunRequestPayload | null {
	if (!isPlainObject(value)) return null
	if (typeof value.task !== 'string' || value.task.trim().length === 0) return null

	return {
		taskId:
			typeof value.taskId === 'string' && value.taskId.trim().length > 0 ? value.taskId : undefined,
		task: value.task,
		llm: isStringRecord(value.llm) ? value.llm : undefined,
		options: isStringRecord(value.options) ? value.options : undefined,
	}
}

function parseStatusPayload(value: unknown): CompanionStatusRequestPayload | null {
	if (value === undefined) return {}
	if (!isPlainObject(value)) return null

	if (
		value.taskId !== undefined &&
		value.taskId !== null &&
		(typeof value.taskId !== 'string' || value.taskId.trim().length === 0)
	) {
		return null
	}

	return {
		taskId: (value.taskId as string | null | undefined) ?? undefined,
	}
}

function parseStopPayload(value: unknown): CompanionStopRequestPayload | null {
	if (!isPlainObject(value)) return null

	if (
		value.taskId !== undefined &&
		value.taskId !== null &&
		(typeof value.taskId !== 'string' || value.taskId.trim().length === 0)
	) {
		return null
	}

	return {
		taskId: (value.taskId as string | null | undefined) ?? undefined,
	}
}

export function parseCompanionRequest(data: unknown): ParsedCompanionRequestResult {
	if (typeof data !== 'string') {
		return {
			ok: false,
			requestId: null,
			code: 'invalid_message',
			message: 'Message must be a JSON string.',
		}
	}

	let parsed: unknown

	try {
		parsed = JSON.parse(data)
	} catch {
		return {
			ok: false,
			requestId: null,
			code: 'invalid_message',
			message: 'Message is not valid JSON.',
		}
	}

	if (!isPlainObject(parsed)) {
		return {
			ok: false,
			requestId: null,
			code: 'invalid_message',
			message: 'Message must be a JSON object.',
		}
	}

	const requestId = normalizeRequestId(parsed.requestId)
	const requestType = typeof parsed.type === 'string' ? parsed.type : undefined

	if (!isRequestType(parsed.type)) {
		return {
			ok: false,
			requestId,
			requestType,
			code: 'unsupported_request',
			message: `Unsupported request type: ${String(parsed.type)}`,
		}
	}

	switch (parsed.type) {
		case 'hello': {
			const payload = parseHelloPayload(parsed.payload)
			if (!payload) {
				return {
					ok: false,
					requestId,
					requestType: parsed.type,
					code: 'invalid_payload',
					message: 'Invalid hello payload.',
				}
			}

			return {
				ok: true,
				envelope: {
					type: 'hello',
					requestId,
					payload,
				},
			}
		}

		case 'pair': {
			const payload = parsePairPayload(parsed.payload)
			if (!payload) {
				return {
					ok: false,
					requestId,
					requestType: parsed.type,
					code: 'invalid_payload',
					message: 'Invalid pair payload.',
				}
			}

			return {
				ok: true,
				envelope: {
					type: 'pair',
					requestId,
					payload,
				},
			}
		}

		case 'run': {
			const payload = parseRunPayload(parsed.payload)
			if (!payload) {
				return {
					ok: false,
					requestId,
					requestType: parsed.type,
					code: 'invalid_payload',
					message: 'Invalid run payload.',
				}
			}

			return {
				ok: true,
				envelope: {
					type: 'run',
					requestId,
					payload,
				},
			}
		}

		case 'status': {
			const payload = parseStatusPayload(parsed.payload)
			if (!payload) {
				return {
					ok: false,
					requestId,
					requestType: parsed.type,
					code: 'invalid_payload',
					message: 'Invalid status payload.',
				}
			}

			return {
				ok: true,
				envelope: {
					type: 'status',
					requestId,
					payload,
				},
			}
		}

		case 'stop': {
			const payload = parseStopPayload(parsed.payload)
			if (!payload) {
				return {
					ok: false,
					requestId,
					requestType: parsed.type,
					code: 'invalid_payload',
					message: 'Invalid stop payload.',
				}
			}

			return {
				ok: true,
				envelope: {
					type: 'stop',
					requestId,
					payload,
				},
			}
		}
	}
}

export function createAckEnvelope(
	requestId: string | null,
	payload: CompanionAckPayload
): CompanionEnvelope<'ack', CompanionAckPayload> {
	return {
		type: 'ack',
		requestId,
		payload,
	}
}

export function createErrorEnvelope(
	requestId: string | null,
	payload: CompanionErrorPayload
): CompanionEnvelope<'error', CompanionErrorPayload> {
	return {
		type: 'error',
		requestId,
		payload,
	}
}

export function createStatusEnvelope(
	requestId: string | null,
	payload: CompanionStatusPayload
): CompanionEnvelope<'status', CompanionStatusPayload> {
	return {
		type: 'status',
		requestId,
		payload,
	}
}

export function createTaskSnapshot(
	state: CompanionStorageState,
	taskId: string | null | undefined = state.companionCurrentTaskId
): CompanionTaskSnapshot {
	if (taskId && state.companionCurrentTaskId && taskId !== state.companionCurrentTaskId) {
		return {
			taskId,
			status: 'idle',
			lastError: null,
			lastSeenAt: state.companionLastSeenAt,
		}
	}

	const status: CompanionTaskStatus = state.companionCurrentTaskStatus ?? 'idle'

	return {
		taskId: taskId ?? null,
		status,
		lastError: state.companionLastError,
		lastSeenAt: state.companionLastSeenAt,
	}
}
