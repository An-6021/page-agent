import {
	ensureCompanionStorageDefaults,
	getCompanionStorageState,
	setCompanionConnectionState,
	updateCompanionStorageState,
} from '@/companion/storage/companion-store'

const PREFIX = '[Companion.background]'
const RECONNECT_DELAY_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 15_000

interface CompanionEnvelope {
	type?: string
	requestId?: string
	payload?: unknown
}

class CompanionBackgroundRuntime {
	#socket: WebSocket | null = null
	#socketUrl: string | null = null
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null
	#heartbeatTimer: ReturnType<typeof setInterval> | null = null
	#initialized = false

	async start(): Promise<void> {
		if (this.#initialized) return
		this.#initialized = true

		await ensureCompanionStorageDefaults()
		chrome.storage.onChanged.addListener(this.#handleStorageChanged)
		await this.#syncConnection('startup')
	}

	#handleStorageChanged = (
		changes: Record<string, chrome.storage.StorageChange>,
		areaName: string
	): void => {
		if (areaName !== 'local') return

		if (
			changes.companionEnabled === undefined &&
			changes.companionServerUrl === undefined &&
			changes.companionPairToken === undefined
		) {
			return
		}

		void this.#syncConnection('storage_change')
	}

	async #syncConnection(reason: 'startup' | 'storage_change' | 'reconnect'): Promise<void> {
		const state = await getCompanionStorageState()

		if (!state.companionEnabled) {
			this.#clearReconnectTimer()
			this.#disposeSocket()

			await setCompanionConnectionState('disabled', {
				lastError: null,
				lastSeenAt: null,
			})
			console.info(`${PREFIX} Companion mode is disabled.`)
			return
		}

		if (
			this.#socketUrl === state.companionServerUrl &&
			this.#socket &&
			(this.#socket.readyState === WebSocket.CONNECTING ||
				this.#socket.readyState === WebSocket.OPEN)
		) {
			return
		}

		await this.#openSocket(state.companionServerUrl, reason)
	}

	async #openSocket(
		url: string,
		reason: 'startup' | 'storage_change' | 'reconnect'
	): Promise<void> {
		this.#clearReconnectTimer()
		this.#disposeSocket()

		try {
			const socket = new WebSocket(url)
			this.#socket = socket
			this.#socketUrl = url

			await updateCompanionStorageState({
				companionConnectionState: 'connecting',
				companionLastError: null,
			})

			console.info(`${PREFIX} Connecting to helper.`, JSON.stringify({ url, reason }))

			socket.addEventListener('open', () => {
				if (this.#socket !== socket) return

				this.#startHeartbeat(socket)
				void setCompanionConnectionState('connected', {
					lastError: null,
					lastSeenAt: Date.now(),
				})
				console.info(`${PREFIX} Helper connected.`, JSON.stringify({ url }))
			})

			socket.addEventListener('message', (event) => {
				if (this.#socket !== socket) return
				void this.#handleMessage(event)
			})

			socket.addEventListener('error', () => {
				if (this.#socket !== socket) return

				void setCompanionConnectionState('error', {
					lastError: `WebSocket error while connecting to ${url}.`,
				})
				console.error(`${PREFIX} Helper connection error.`, JSON.stringify({ url }))
			})

			socket.addEventListener('close', (event) => {
				if (this.#socket !== socket) return

				this.#stopHeartbeat()
				this.#socket = null
				this.#socketUrl = null
				void this.#handleClose(url, event)
			})
		} catch (error) {
			this.#socket = null
			this.#socketUrl = null

			const message = error instanceof Error ? error.message : `Invalid WebSocket URL: ${url}`

			await setCompanionConnectionState('error', {
				lastError: message,
			})

			console.error(`${PREFIX} Failed to create WebSocket connection.`, error)
		}
	}

	async #handleMessage(event: MessageEvent): Promise<void> {
		const envelope = this.#parseEnvelope(event.data)

		await setCompanionConnectionState('connected', {
			lastError: null,
			lastSeenAt: Date.now(),
		})

		if (!envelope) {
			console.debug(`${PREFIX} Received non-JSON message from helper.`)
			return
		}

		console.debug(
			`${PREFIX} Received message from helper.`,
			JSON.stringify({
				type: envelope.type ?? 'unknown',
				requestId: envelope.requestId ?? null,
			})
		)
	}

	async #handleClose(url: string, event: CloseEvent): Promise<void> {
		const state = await getCompanionStorageState()

		if (!state.companionEnabled) {
			await setCompanionConnectionState('disabled', {
				lastError: null,
				lastSeenAt: null,
			})
			return
		}

		const lastError =
			event.wasClean || event.code === 1000 ? null : `Socket closed unexpectedly (${event.code}).`

		await setCompanionConnectionState('disconnected', {
			lastError,
		})

		console.warn(
			`${PREFIX} Helper disconnected.`,
			JSON.stringify({
				url,
				code: event.code,
				wasClean: event.wasClean,
			})
		)

		this.#scheduleReconnect()
	}

	#scheduleReconnect(): void {
		if (this.#reconnectTimer) return

		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = null
			void this.#syncConnection('reconnect')
		}, RECONNECT_DELAY_MS)
	}

	#clearReconnectTimer(): void {
		if (!this.#reconnectTimer) return
		clearTimeout(this.#reconnectTimer)
		this.#reconnectTimer = null
	}

	#startHeartbeat(socket: WebSocket): void {
		this.#stopHeartbeat()

		this.#heartbeatTimer = setInterval(() => {
			if (socket.readyState !== WebSocket.OPEN) return

			socket.send(
				JSON.stringify({
					type: 'ping',
					payload: {
						source: 'extension',
						timestamp: Date.now(),
					},
				})
			)
		}, HEARTBEAT_INTERVAL_MS)
	}

	#stopHeartbeat(): void {
		if (!this.#heartbeatTimer) return
		clearInterval(this.#heartbeatTimer)
		this.#heartbeatTimer = null
	}

	#disposeSocket(): void {
		this.#stopHeartbeat()

		if (!this.#socket) {
			this.#socketUrl = null
			return
		}

		const socket = this.#socket
		this.#socket = null
		this.#socketUrl = null

		if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
			socket.close(1000, 'Companion runtime reset')
		}
	}

	#parseEnvelope(data: unknown): CompanionEnvelope | null {
		if (typeof data !== 'string') return null

		try {
			const parsed = JSON.parse(data) as CompanionEnvelope
			return typeof parsed === 'object' && parsed !== null ? parsed : null
		} catch {
			return null
		}
	}
}

let runtime: CompanionBackgroundRuntime | null = null

export async function initializeCompanionBackgroundRuntime(): Promise<void> {
	try {
		runtime ??= new CompanionBackgroundRuntime()
		await runtime.start()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		await setCompanionConnectionState('error', {
			lastError: message,
		})
		console.error(`${PREFIX} Failed to initialize runtime.`, error)
	}
}
