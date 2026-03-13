import {
	COMPANION_OFFSCREEN_MESSAGE_TYPE,
	COMPANION_OFFSCREEN_TARGET,
	type CompanionOffscreenRequest,
	type CompanionOffscreenResponse,
} from '@/companion/protocol/offscreen'

const PREFIX = '[Companion.offscreen]'

console.info(`${PREFIX} Offscreen document loaded.`)

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: CompanionOffscreenResponse) => void
	): true | undefined => {
		if (!isCompanionOffscreenRequest(message)) return

		if (message.action === 'ping') {
			sendResponse({
				ok: true,
				target: COMPANION_OFFSCREEN_TARGET,
				action: 'ping',
				ready: true,
				timestamp: Date.now(),
			})
			return true
		}

		sendResponse({
			ok: false,
			target: COMPANION_OFFSCREEN_TARGET,
			action: 'ping',
			ready: false,
			timestamp: Date.now(),
			error: `Unsupported offscreen action: ${String((message as { action?: unknown }).action)}`,
		})
		return true
	}
)

function isCompanionOffscreenRequest(value: unknown): value is CompanionOffscreenRequest {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false

	return (
		(value as { type?: unknown }).type === COMPANION_OFFSCREEN_MESSAGE_TYPE &&
		(value as { target?: unknown }).target === COMPANION_OFFSCREEN_TARGET &&
		(value as { action?: unknown }).action === 'ping'
	)
}
