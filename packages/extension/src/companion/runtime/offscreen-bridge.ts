import type {
	CompanionRunRequestPayload,
	CompanionStatusRequestPayload,
	CompanionStopRequestPayload,
} from '@/companion/protocol/messages'
import {
	COMPANION_OFFSCREEN_DOCUMENT_PATH,
	createCompanionOffscreenPingRequest,
	createCompanionOffscreenRunRequest,
	createCompanionOffscreenStatusRequest,
	createCompanionOffscreenStopRequest,
	isCompanionOffscreenResponse,
} from '@/companion/protocol/offscreen'
import type { CompanionOffscreenResponse } from '@/companion/protocol/offscreen'

const OFFSCREEN_JUSTIFICATION =
	'Need a hidden DOM-enabled document to host the Page Agent companion executor runtime.'

let creatingDocumentPromise: Promise<void> | null = null

async function hasCompanionOffscreenDocument(): Promise<boolean> {
	const contexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
		documentUrls: [chrome.runtime.getURL(COMPANION_OFFSCREEN_DOCUMENT_PATH)],
	})

	return contexts.length > 0
}

export async function ensureCompanionOffscreenDocument(): Promise<void> {
	if (await hasCompanionOffscreenDocument()) return

	if (creatingDocumentPromise) {
		await creatingDocumentPromise
		return
	}

	creatingDocumentPromise = chrome.offscreen
		.createDocument({
			url: COMPANION_OFFSCREEN_DOCUMENT_PATH,
			reasons: [chrome.offscreen.Reason.DOM_PARSER],
			justification: OFFSCREEN_JUSTIFICATION,
		})
		.finally(() => {
			creatingDocumentPromise = null
		})

	await creatingDocumentPromise
}

export async function closeCompanionOffscreenDocument(): Promise<void> {
	if (!(await hasCompanionOffscreenDocument())) return
	await chrome.offscreen.closeDocument()
}

export async function pingCompanionOffscreen(): Promise<void> {
	await ensureCompanionOffscreenDocument()

	const response = await chrome.runtime.sendMessage(createCompanionOffscreenPingRequest())

	if (!isCompanionOffscreenResponse(response)) {
		throw new Error('Offscreen document returned an invalid response.')
	}

	if (!response.ok || !response.ready) {
		throw new Error(response.error || 'Offscreen document is not ready.')
	}
}

export async function runCompanionOffscreen(
	payload: CompanionRunRequestPayload
): Promise<CompanionOffscreenResponse<'run'>> {
	return sendCompanionOffscreenRequest(createCompanionOffscreenRunRequest(payload))
}

export async function getCompanionOffscreenStatus(
	payload: CompanionStatusRequestPayload = {}
): Promise<CompanionOffscreenResponse<'status'>> {
	return sendCompanionOffscreenRequest(createCompanionOffscreenStatusRequest(payload))
}

export async function stopCompanionOffscreen(
	payload: CompanionStopRequestPayload = {}
): Promise<CompanionOffscreenResponse<'stop'>> {
	return sendCompanionOffscreenRequest(createCompanionOffscreenStopRequest(payload))
}

async function sendCompanionOffscreenRequest<TAction extends 'run' | 'status' | 'stop'>(
	request:
		| ReturnType<typeof createCompanionOffscreenRunRequest>
		| ReturnType<typeof createCompanionOffscreenStatusRequest>
		| ReturnType<typeof createCompanionOffscreenStopRequest>
): Promise<CompanionOffscreenResponse<TAction>> {
	await ensureCompanionOffscreenDocument()

	const response = await chrome.runtime.sendMessage(request)

	if (!isCompanionOffscreenResponse(response)) {
		throw new Error('Offscreen document returned an invalid response.')
	}

	return response as CompanionOffscreenResponse<TAction>
}
