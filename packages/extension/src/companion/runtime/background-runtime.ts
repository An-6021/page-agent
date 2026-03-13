import {
	COMPANION_PROTOCOL_VERSION,
	type CompanionRunRequestPayload,
	type CompanionStatusRequestPayload,
	type CompanionStopRequestPayload,
	createAckEnvelope,
	createErrorEnvelope,
	createStatusEnvelope,
	createTaskSnapshot,
	parseCompanionRequest,
} from '@/companion/protocol/messages'
import {
	closeCompanionOffscreenDocument,
	ensureCompanionOffscreenDocument,
	getCompanionOffscreenStatus,
	pingCompanionOffscreen,
	runCompanionOffscreen,
	stopCompanionOffscreen,
} from '@/companion/runtime/offscreen-bridge'
import {
	ensureCompanionStorageDefaults,
	getCompanionStorageState,
	setCompanionConnectionState,
	updateCompanionStorageState,
} from '@/companion/storage/companion-store'

const PREFIX = '[Companion.background]'
const RECONNECT_DELAY_MS = 2_000
const HEARTBEAT_INTERVAL_MS = 15_000

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
			await closeCompanionOffscreenDocument()

			await setCompanionConnectionState('disabled', {
				lastError: null,
				lastSeenAt: null,
			})
			console.info(`${PREFIX} Companion mode is disabled.`)
			return
		}

		try {
			await ensureCompanionOffscreenDocument()
			await pingCompanionOffscreen()
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: 'Failed to initialize companion offscreen document.'

			await setCompanionConnectionState('error', {
				lastError: message,
			})
			console.error(`${PREFIX} Offscreen initialization failed.`, error)
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
		const parsed = parseCompanionRequest(event.data)

		await setCompanionConnectionState('connected', {
			lastError: null,
			lastSeenAt: Date.now(),
		})

		if (!parsed.ok) {
			this.#sendEnvelope(
				createErrorEnvelope(parsed.requestId, {
					code: parsed.code,
					message: parsed.message,
					requestType: parsed.requestType,
				})
			)
			console.warn(
				`${PREFIX} Invalid helper request.`,
				JSON.stringify({
					code: parsed.code,
					requestType: parsed.requestType ?? null,
				})
			)
			return
		}

		const { envelope } = parsed

		console.debug(
			`${PREFIX} Received message from helper.`,
			JSON.stringify({
				type: envelope.type ?? 'unknown',
				requestId: envelope.requestId ?? null,
			})
		)

		switch (envelope.type) {
			case 'hello':
				await this.#handleHello(envelope.requestId)
				return
			case 'pair':
				await this.#handlePair(envelope.requestId, envelope.payload.pairToken)
				return
			case 'status':
				await this.#handleStatus(envelope.requestId, envelope.payload.taskId)
				return
			case 'run':
				await this.#handleRun(envelope.requestId, envelope.payload)
				return
			case 'stop':
				await this.#handleStop(envelope.requestId, envelope.payload)
				return
		}
	}

	async #handleClose(url: string, event: CloseEvent): Promise<void> {
		const state = await getCompanionStorageState()

		if (!state.companionEnabled) {
			await setCompanionConnectionState('disabled', {
				lastError: null,
				lastSeenAt: null,
			})
			await closeCompanionOffscreenDocument()
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

	async #handleHello(requestId: string | null): Promise<void> {
		this.#sendEnvelope(
			createAckEnvelope(requestId, {
				accepted: true,
				requestType: 'hello',
				protocolVersion: COMPANION_PROTOCOL_VERSION,
				capabilities: ['hello', 'pair', 'run', 'status', 'stop'],
			})
		)
	}

	async #handlePair(requestId: string | null, pairToken: string): Promise<void> {
		const state = await getCompanionStorageState()

		if (state.companionPairToken && state.companionPairToken !== pairToken) {
			this.#sendEnvelope(
				createErrorEnvelope(requestId, {
					code: 'pairing_mismatch',
					message: 'Pair token does not match the current companion binding.',
					requestType: 'pair',
				})
			)
			return
		}

		if (!state.companionPairToken) {
			await updateCompanionStorageState({
				companionPairToken: pairToken,
			})
		}

		this.#sendEnvelope(
			createAckEnvelope(requestId, {
				accepted: true,
				requestType: 'pair',
				protocolVersion: COMPANION_PROTOCOL_VERSION,
				paired: true,
			})
		)
	}

	async #handleStatus(requestId: string | null, taskId?: string | null): Promise<void> {
		try {
			await ensureCompanionOffscreenDocument()
			const response = await getCompanionOffscreenStatus({ taskId })

			if (!response.ok || !response.task) {
				this.#sendOffscreenError(
					requestId,
					'status',
					response.code ?? 'execution_error',
					response.error ?? 'Failed to fetch task status from offscreen executor.'
				)
				return
			}

			await this.#sendTaskStatusEnvelope(requestId, response.task)
		} catch (error) {
			const state = await getCompanionStorageState()
			this.#sendEnvelope(
				createStatusEnvelope(requestId, {
					task: createTaskSnapshot(state, taskId),
					connectionState: state.companionConnectionState,
					paired: Boolean(state.companionPairToken),
					protocolVersion: COMPANION_PROTOCOL_VERSION,
				})
			)
		}
	}

	async #handleRun(requestId: string | null, payload: CompanionRunRequestPayload): Promise<void> {
		const state = await getCompanionStorageState()

		if (!state.companionPairToken) {
			this.#sendEnvelope(
				createErrorEnvelope(requestId, {
					code: 'pairing_required',
					message: 'Companion must be paired before task control commands are allowed.',
					requestType: 'run',
				})
			)
			return
		}

		try {
			await ensureCompanionOffscreenDocument()
			const response = await runCompanionOffscreen(payload)

			if (!response.ok || !response.task) {
				this.#sendOffscreenError(
					requestId,
					'run',
					response.code ?? 'execution_error',
					response.error ?? 'Failed to start the task in the offscreen executor.'
				)
				return
			}

			await this.#sendTaskStatusEnvelope(requestId, response.task)
		} catch (error) {
			this.#sendEnvelope(
				createErrorEnvelope(requestId, {
					code: 'execution_error',
					message:
						error instanceof Error
							? error.message
							: 'Failed to start the task in the offscreen executor.',
					requestType: 'run',
				})
			)
		}
	}

	async #handleStop(requestId: string | null, payload: CompanionStopRequestPayload): Promise<void> {
		const state = await getCompanionStorageState()

		if (!state.companionPairToken) {
			this.#sendEnvelope(
				createErrorEnvelope(requestId, {
					code: 'pairing_required',
					message: 'Companion must be paired before task control commands are allowed.',
					requestType: 'stop',
				})
			)
			return
		}

		try {
			await ensureCompanionOffscreenDocument()
			const response = await stopCompanionOffscreen(payload)

			if (!response.ok || !response.task) {
				this.#sendOffscreenError(
					requestId,
					'stop',
					response.code ?? 'execution_error',
					response.error ?? 'Failed to stop the task in the offscreen executor.'
				)
				return
			}

			await this.#sendTaskStatusEnvelope(requestId, response.task)
		} catch (error) {
			this.#sendEnvelope(
				createErrorEnvelope(requestId, {
					code: 'execution_error',
					message:
						error instanceof Error
							? error.message
							: 'Failed to stop the task in the offscreen executor.',
					requestType: 'stop',
				})
			)
		}
	}

	async #sendTaskStatusEnvelope(
		requestId: string | null,
		task: ReturnType<typeof createTaskSnapshot>
	): Promise<void> {
		const state = await getCompanionStorageState()

		this.#sendEnvelope(
			createStatusEnvelope(requestId, {
				task,
				connectionState: state.companionConnectionState,
				paired: Boolean(state.companionPairToken),
				protocolVersion: COMPANION_PROTOCOL_VERSION,
			})
		)
	}

	#sendOffscreenError(
		requestId: string | null,
		requestType: 'run' | 'status' | 'stop',
		code: 'invalid_payload' | 'task_conflict' | 'task_not_found' | 'execution_error',
		message: string
	): void {
		this.#sendEnvelope(
			createErrorEnvelope(requestId, {
				code,
				message,
				requestType,
			})
		)
	}

	#sendEnvelope(envelope: unknown): void {
		if (!this.#socket || this.#socket.readyState !== WebSocket.OPEN) {
			console.warn(`${PREFIX} Unable to send message because helper socket is not open.`)
			return
		}

		this.#socket.send(JSON.stringify(envelope))
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
