import {
	ensureCompanionStorageDefaults,
	getCompanionStorageState,
	setCompanionConnectionState,
} from '@/companion/storage/companion-store'

const PREFIX = '[Companion.background]'

export async function initializeCompanionBackgroundRuntime(): Promise<void> {
	try {
		await ensureCompanionStorageDefaults()

		const state = await getCompanionStorageState()

		if (!state.companionEnabled) {
			await setCompanionConnectionState('disabled', {
				lastError: null,
				lastSeenAt: null,
			})
			console.info(`${PREFIX} Companion mode is disabled.`)
			return
		}

		await setCompanionConnectionState('disconnected', {
			lastError: null,
		})

		console.info(
			`${PREFIX} Runtime initialized.`,
			JSON.stringify({
				paired: Boolean(state.companionPairToken),
				taskId: state.companionCurrentTaskId,
			})
		)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await setCompanionConnectionState('error', {
			lastError: message,
		})
		console.error(`${PREFIX} Failed to initialize runtime.`, error)
	}
}
