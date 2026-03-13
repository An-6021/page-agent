import {
	COMPANION_OFFSCREEN_DOCUMENT_PATH,
	createCompanionOffscreenPingRequest,
	isCompanionOffscreenResponse,
} from '@/companion/protocol/offscreen'

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
