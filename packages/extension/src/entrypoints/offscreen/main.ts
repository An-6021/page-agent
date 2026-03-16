import {
	type CompanionOffscreenResponse,
	isCompanionOffscreenRequest,
} from '@/companion/protocol/offscreen'
import { initializeCompanionOffscreenRuntime } from '@/companion/runtime/offscreen-runtime'

const PREFIX = '[Companion.offscreen]'
const runtime = initializeCompanionOffscreenRuntime()

console.info(`${PREFIX} Offscreen document loaded.`)

chrome.runtime.onMessage.addListener(
	(
		message: unknown,
		_sender: chrome.runtime.MessageSender,
		sendResponse: (response: CompanionOffscreenResponse) => void
	): true | undefined => {
		if (!isCompanionOffscreenRequest(message)) return

		void runtime
			.handleMessage(message)
			.then(sendResponse)
			.catch((error) => {
				const errorText =
					error instanceof Error
						? error.stack
							? `${error.message}\n${error.stack}`
							: error.message
						: String(error)

				sendResponse({
					ok: false,
					target: 'companion-offscreen',
					action: message.action,
					ready: true,
					timestamp: Date.now(),
					code: 'execution_error',
					error: errorText,
				})
			})

		return true
	}
)
