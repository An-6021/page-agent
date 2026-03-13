import type { AgentActivity, AgentStatus } from '@page-agent/core'

import { MultiPageAgent } from '@/agent/MultiPageAgent'
import { type AdvancedConfig, type ExtConfig, loadStoredAgentConfig } from '@/agent/config'
import type {
	CompanionEventEnvelope,
	CompanionResultPayload,
	CompanionRunRequestPayload,
	CompanionStatusRequestPayload,
	CompanionStopRequestPayload,
} from '@/companion/protocol/messages'
import {
	createActivityEnvelope,
	createResultEnvelope,
	createStatusChangedEnvelope,
} from '@/companion/protocol/messages'
import type {
	CompanionOffscreenRequest,
	CompanionOffscreenResponse,
} from '@/companion/protocol/offscreen'
import { createCompanionBackgroundEventMessage } from '@/companion/protocol/offscreen'
import { updateCompanionStorageState } from '@/companion/storage/companion-store'
import type { CompanionTaskSnapshot, CompanionTaskStatus } from '@/types/companion'

const PREFIX = '[Companion.offscreen]'

class CompanionOffscreenRuntime {
	#agent: MultiPageAgent | null = null
	#activeTaskId: string | null = null
	#activeTaskPromise: Promise<void> | null = null
	#agentCleanup: (() => void) | null = null
	#stopRequested = false
	#snapshot: CompanionTaskSnapshot = {
		taskId: null,
		status: 'idle',
		lastError: null,
		lastSeenAt: null,
	}

	async handleMessage(message: CompanionOffscreenRequest): Promise<CompanionOffscreenResponse> {
		switch (message.action) {
			case 'ping':
				return this.#createResponse('ping', {
					ok: true,
				})
			case 'run':
				return this.#handleRun(message.payload as CompanionRunRequestPayload | undefined)
			case 'status':
				return this.#handleStatus(message.payload as CompanionStatusRequestPayload | undefined)
			case 'stop':
				return this.#handleStop(message.payload as CompanionStopRequestPayload | undefined)
		}
	}

	async #handleRun(
		payload: CompanionRunRequestPayload | undefined
	): Promise<CompanionOffscreenResponse> {
		if (!payload) {
			return this.#createResponse('run', {
				ok: false,
				code: 'invalid_payload',
				error: 'Missing run payload.',
			})
		}

		if (this.#activeTaskPromise || this.#activeTaskId || this.#agent) {
			return this.#createResponse('run', {
				ok: false,
				code: 'task_conflict',
				error: 'Another companion task is already running.',
				task: this.#snapshot,
			})
		}

		const taskId = payload.taskId ?? crypto.randomUUID()
		const config = await this.#buildRunConfig(payload)

		const agent = new MultiPageAgent(config)
		this.#agent = agent
		this.#activeTaskId = taskId
		this.#stopRequested = false
		this.#bindAgent(agent, taskId)

		await this.#setSnapshot(
			{
				taskId,
				status: 'queued',
				lastError: null,
			},
			false
		)

		this.#activeTaskPromise = this.#executeTask(agent, taskId, payload.task)

		return this.#createResponse('run', {
			ok: true,
			task: this.#snapshot,
			accepted: true,
		})
	}

	async #handleStatus(
		payload: CompanionStatusRequestPayload | undefined
	): Promise<CompanionOffscreenResponse> {
		const requestedTaskId = payload?.taskId ?? null

		if (requestedTaskId && this.#snapshot.taskId && requestedTaskId !== this.#snapshot.taskId) {
			return this.#createResponse('status', {
				ok: true,
				task: {
					taskId: requestedTaskId,
					status: 'idle',
					lastError: null,
					lastSeenAt: this.#snapshot.lastSeenAt,
				},
			})
		}

		return this.#createResponse('status', {
			ok: true,
			task: this.#snapshot,
		})
	}

	async #handleStop(
		payload: CompanionStopRequestPayload | undefined
	): Promise<CompanionOffscreenResponse> {
		const requestedTaskId = payload?.taskId ?? this.#snapshot.taskId

		if (!requestedTaskId || !this.#activeTaskId || requestedTaskId !== this.#activeTaskId) {
			return this.#createResponse('stop', {
				ok: false,
				code: 'task_not_found',
				error: 'The requested task is not running in the companion executor.',
				task: this.#snapshot,
			})
		}

		if (!this.#agent) {
			return this.#createResponse('stop', {
				ok: false,
				code: 'task_not_found',
				error: 'The companion executor has no active agent instance.',
				task: this.#snapshot,
			})
		}

		if (this.#stopRequested) {
			return this.#createResponse('stop', {
				ok: true,
				task: this.#snapshot,
				accepted: true,
			})
		}

		this.#stopRequested = true

		await this.#setSnapshot({
			taskId: this.#activeTaskId,
			status: 'stopped',
			lastError: null,
		})

		this.#agent.stop()

		return this.#createResponse('stop', {
			ok: true,
			task: this.#snapshot,
			accepted: true,
		})
	}

	async #executeTask(agent: MultiPageAgent, taskId: string, task: string): Promise<void> {
		try {
			const result = await agent.execute(task)

			if (this.#agent !== agent || this.#activeTaskId !== taskId) return

			if (this.#stopRequested) {
				await this.#setSnapshot({
					taskId,
					status: 'stopped',
					lastError: null,
				})
				this.#emitResult(this.#snapshot, {
					success: result.success,
					data: this.#normalizeResultData(result.data),
					history: result.history,
				})
				return
			}

			await this.#setSnapshot({
				taskId,
				status: result.success ? 'completed' : 'error',
				lastError: result.success ? null : this.#normalizeErrorMessage(result.data),
			})
			this.#emitResult(this.#snapshot, {
				success: result.success,
				data: this.#normalizeResultData(result.data),
				history: result.history,
			})
		} catch (error) {
			if (this.#agent !== agent || this.#activeTaskId !== taskId) return

			const message = this.#normalizeErrorMessage(error)

			await this.#setSnapshot({
				taskId,
				status: this.#stopRequested ? 'stopped' : 'error',
				lastError: this.#stopRequested ? null : message,
			})
			this.#emitResult(this.#snapshot, {
				success: false,
				data: message,
				history: [...agent.history],
			})
		} finally {
			if (this.#agentCleanup) {
				this.#agentCleanup()
				this.#agentCleanup = null
			}

			if (this.#agent === agent) {
				this.#agent = null
			}

			if (this.#activeTaskId === taskId) {
				this.#activeTaskId = null
			}

			if (this.#activeTaskPromise) {
				this.#activeTaskPromise = null
			}

			agent.dispose()
		}
	}

	#bindAgent(agent: MultiPageAgent, taskId: string): void {
		const handleStatusChange = () => {
			const status = this.#mapAgentStatus(agent.status)
			if (!status) return

			void this.#setSnapshot({
				taskId,
				status,
				lastError:
					status === 'error'
						? (this.#snapshot.lastError ?? 'The agent reported an error state.')
						: null,
			})
		}
		const handleActivity = (event: Event) => {
			const activity = (event as CustomEvent<AgentActivity>).detail
			this.#emitActivity(taskId, activity)
		}

		agent.addEventListener('statuschange', handleStatusChange)
		agent.addEventListener('activity', handleActivity)
		this.#agentCleanup = () => {
			agent.removeEventListener('statuschange', handleStatusChange)
			agent.removeEventListener('activity', handleActivity)
		}
	}

	#mapAgentStatus(status: AgentStatus): CompanionTaskStatus | null {
		switch (status) {
			case 'idle':
				return null
			case 'running':
				return 'running'
			case 'completed':
				return 'completed'
			case 'error':
				return this.#stopRequested ? 'stopped' : 'error'
		}

		return null
	}

	async #buildRunConfig(payload: CompanionRunRequestPayload): Promise<
		ExtConfig & {
			includeInitialTab?: boolean
			instructions?: { system: string }
		}
	> {
		const storedConfig = await loadStoredAgentConfig()
		const llmOverrides = this.#extractLLMOverrides(payload.llm)
		const advancedOverrides = this.#extractAdvancedOverrides(payload.options)

		const { systemInstruction, includeInitialTab, ...advancedConfig } = advancedOverrides

		return {
			...storedConfig,
			...llmOverrides,
			...advancedConfig,
			instructions: systemInstruction ? { system: systemInstruction } : undefined,
			includeInitialTab,
		}
	}

	#extractLLMOverrides(value: Record<string, unknown> | undefined): {
		baseURL?: string
		apiKey?: string
		model?: string
	} {
		if (!value) return {}

		const patch: {
			baseURL?: string
			apiKey?: string
			model?: string
		} = {}

		if (typeof value.baseURL === 'string' && value.baseURL.trim().length > 0) {
			patch.baseURL = value.baseURL
		}

		if (typeof value.apiKey === 'string' && value.apiKey.trim().length > 0) {
			patch.apiKey = value.apiKey
		}

		if (typeof value.model === 'string' && value.model.trim().length > 0) {
			patch.model = value.model
		}

		return patch
	}

	#extractAdvancedOverrides(value: Record<string, unknown> | undefined): Partial<AdvancedConfig> & {
		includeInitialTab?: boolean
	} {
		if (!value) return {}

		const patch: Partial<AdvancedConfig> & {
			includeInitialTab?: boolean
		} = {}

		if (typeof value.maxSteps === 'number' && Number.isFinite(value.maxSteps)) {
			patch.maxSteps = value.maxSteps
		}

		if (typeof value.systemInstruction === 'string' && value.systemInstruction.trim().length > 0) {
			patch.systemInstruction = value.systemInstruction
		}

		if (typeof value.experimentalLlmsTxt === 'boolean') {
			patch.experimentalLlmsTxt = value.experimentalLlmsTxt
		}

		if (typeof value.includeInitialTab === 'boolean') {
			patch.includeInitialTab = value.includeInitialTab
		}

		return patch
	}

	async #setSnapshot(
		snapshot: Omit<CompanionTaskSnapshot, 'lastSeenAt'> & {
			lastSeenAt?: number | null
		},
		emitEvent: boolean = true
	): Promise<void> {
		const shouldEmitStatusChanged =
			emitEvent &&
			(this.#snapshot.taskId !== (snapshot.taskId ?? null) ||
				this.#snapshot.status !== snapshot.status ||
				this.#snapshot.lastError !== (snapshot.lastError ?? null))

		const nextSnapshot: CompanionTaskSnapshot = {
			taskId: snapshot.taskId ?? null,
			status: snapshot.status,
			lastError: snapshot.lastError ?? null,
			lastSeenAt: snapshot.lastSeenAt ?? Date.now(),
		}

		this.#snapshot = nextSnapshot

		await updateCompanionStorageState({
			companionCurrentTaskId: nextSnapshot.taskId,
			companionCurrentTaskStatus: nextSnapshot.status,
			companionLastError: nextSnapshot.lastError,
			companionLastSeenAt: nextSnapshot.lastSeenAt,
		})

		console.info(
			`${PREFIX} Task snapshot updated.`,
			JSON.stringify({
				taskId: nextSnapshot.taskId,
				status: nextSnapshot.status,
			})
		)

		if (shouldEmitStatusChanged) {
			this.#emitStatusChanged(nextSnapshot)
		}
	}

	#normalizeErrorMessage(value: unknown): string {
		if (typeof value === 'string' && value.trim().length > 0) return value
		if (value instanceof Error && value.message.trim().length > 0) return value.message
		return String(value)
	}

	#normalizeResultData(value: unknown): string {
		if (typeof value === 'string' && value.trim().length > 0) return value
		if (typeof value === 'string') return value
		return String(value)
	}

	#emitStatusChanged(snapshot: CompanionTaskSnapshot): void {
		this.#notifyBackground(
			createStatusChangedEnvelope(null, {
				taskId: snapshot.taskId,
				status: snapshot.status,
				lastError: snapshot.lastError,
				lastSeenAt: snapshot.lastSeenAt,
			})
		)
	}

	#emitActivity(taskId: string, activity: AgentActivity): void {
		this.#notifyBackground(
			createActivityEnvelope(null, {
				taskId,
				activity,
				lastSeenAt: Date.now(),
			})
		)
	}

	#emitResult(
		snapshot: CompanionTaskSnapshot,
		result: {
			success: boolean
			data: string
			history: CompanionResultPayload['history']
		}
	): void {
		this.#notifyBackground(
			createResultEnvelope(null, {
				taskId: snapshot.taskId,
				success: result.success,
				data: result.data,
				history: result.history,
				status: snapshot.status,
				lastError: snapshot.lastError,
				lastSeenAt: snapshot.lastSeenAt,
			})
		)
	}

	#notifyBackground(envelope: CompanionEventEnvelope): void {
		chrome.runtime.sendMessage(createCompanionBackgroundEventMessage(envelope)).catch((error) => {
			console.warn(`${PREFIX} Failed to notify background.`, error)
		})
	}

	#createResponse(
		action: CompanionOffscreenRequest['action'],
		options: {
			ok: boolean
			task?: CompanionTaskSnapshot
			error?: string
			code?: 'invalid_payload' | 'task_conflict' | 'task_not_found' | 'execution_error'
			accepted?: boolean
		}
	): CompanionOffscreenResponse {
		return {
			ok: options.ok,
			target: 'companion-offscreen',
			action,
			ready: true,
			timestamp: Date.now(),
			task: options.task,
			error: options.error,
			code: options.code,
			accepted: options.accepted,
		}
	}
}

let runtime: CompanionOffscreenRuntime | null = null

export function initializeCompanionOffscreenRuntime(): CompanionOffscreenRuntime {
	runtime ??= new CompanionOffscreenRuntime()
	return runtime
}
