#!/usr/bin/env node
import chalk from 'chalk'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createServer } from 'http'
import { homedir } from 'os'
import { dirname, join } from 'path'
import process from 'process'
import { WebSocket, WebSocketServer } from 'ws'

const HELPER_VERSION = '0.1.0-dev'
const DEFAULT_HELPER_URL = 'ws://127.0.0.1:17888'
const DEFAULT_CONTROL_URL = 'http://127.0.0.1:17889'
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_STATE_FILE = join(homedir(), '.page-agent-companion', 'state.json')
const DEFAULT_INSTANCE_ID = 'browser-default'
const MAX_RECENT_ERRORS = 20

const command = process.argv[2] ?? 'help'
const parsedArgs = parseArgs(process.argv.slice(3))

const helperUrl = parsedArgs.flags['helper-url'] ?? DEFAULT_HELPER_URL
const controlUrl = parsedArgs.flags['control-url'] ?? deriveControlUrl(helperUrl)
const stateFile = parsedArgs.flags['state-file'] ?? DEFAULT_STATE_FILE
const timeoutMs = Number(parsedArgs.flags.timeout ?? DEFAULT_TIMEOUT_MS)
const jsonOutput = parsedArgs.flags.json === true

async function runServeCommand({ helperUrl, controlUrl, stateFile }) {
	const helper = new CompanionDevHelper({
		helperUrl,
		controlUrl,
		stateFile,
	})

	await helper.start()
}

async function runClientCommand(commandName, options) {
	const result = await sendControlCommand({
		commandName,
		controlUrl: options.controlUrl,
		timeoutMs: options.timeoutMs,
		body: options.body,
	})

	if (options.jsonOutput) {
		console.log(JSON.stringify(result, null, 2))
	} else {
		printCommandResult(result)
	}

	process.exitCode = getExitCode(result)
}

async function sendControlCommand({ commandName, controlUrl, timeoutMs, body }) {
	const endpointUrl = new URL(`/${commandName}`, controlUrl)
	const abortController = new AbortController()
	const timeout = setTimeout(() => abortController.abort(), timeoutMs)

	try {
		const response = await fetch(endpointUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
			},
			body: JSON.stringify(body ?? {}),
			signal: abortController.signal,
		})

		const payload = await response.json()
		return payload
	} catch (error) {
		if (error instanceof Error && error.name === 'AbortError') {
			return createFailureResult(commandName, 'timeout', `Timed out after ${timeoutMs}ms.`)
		}

		const message =
			error instanceof Error && error.message === 'fetch failed'
				? 'The local companion helper control endpoint is not reachable.'
				: error instanceof Error
					? error.message
					: 'Unable to reach the local companion helper.'

		return createFailureResult(commandName, 'helper_unavailable', message)
	} finally {
		clearTimeout(timeout)
	}
}

async function loadRunPayload(parsedArgs) {
	const taskFile = parsedArgs.flags['task-file']
	if (typeof taskFile !== 'string' || taskFile.trim().length === 0) {
		throw new Error('run requires --task-file <path>.')
	}

	const fileText = readFileSync(taskFile, 'utf-8')
	const payload = JSON.parse(fileText)

	if (typeof payload.taskId !== 'string' || payload.taskId.trim().length === 0) {
		payload.taskId = randomUUID()
	}

	return payload
}

class CompanionDevHelper {
	#helperUrl
	#controlUrl
	#stateFile
	#helperServer
	#controlServer
	#extensionSocket = null
	#pendingRequests = new Map()
	#state

	constructor({ helperUrl, controlUrl, stateFile }) {
		this.#helperUrl = new URL(helperUrl)
		this.#controlUrl = new URL(controlUrl)
		this.#stateFile = stateFile
		this.#state = loadHelperState(stateFile)
	}

	async start() {
		await this.#startWebSocketServer()
		await this.#startControlServer()
		this.#persistState()
		this.#printStartupSummary()
	}

	async #startWebSocketServer() {
		const { hostname, port, pathname } = normalizeListenUrl(this.#helperUrl)

		this.#helperServer = new WebSocketServer({
			host: hostname,
			port,
			path: pathname,
		})

		this.#helperServer.on('connection', (socket, request) => {
			if (this.#extensionSocket && this.#extensionSocket.readyState === WebSocket.OPEN) {
				this.#extensionSocket.close(1013, 'Replaced by a new extension session.')
			}

			this.#extensionSocket = socket
			this.#setConnectionState('connected')
			this.#logInfo(`Extension connected from ${request.socket.remoteAddress ?? 'unknown'}.`)

			socket.on('message', (data) => {
				this.#handleExtensionMessage(data)
			})

			socket.on('close', () => {
				if (this.#extensionSocket !== socket) return

				this.#extensionSocket = null
				this.#setConnectionState('disconnected')
				this.#logWarn('Extension disconnected.')
			})

			socket.on('error', (error) => {
				this.#recordError('extension_socket_error', error.message)
			})
		})

		await onceServerListening(this.#helperServer)
	}

	async #startControlServer() {
		const { hostname, port } = normalizeListenUrl(this.#controlUrl)

		this.#controlServer = createServer(async (req, res) => {
			if (req.method !== 'POST') {
				this.#sendJson(
					res,
					405,
					createFailureResult('unknown', 'invalid_payload', 'Method not allowed.')
				)
				return
			}

			try {
				const pathname = new URL(req.url ?? '/', this.#controlUrl).pathname
				const body = await readJsonBody(req)

				switch (pathname) {
					case '/doctor':
						this.#sendJson(res, 200, await this.#handleDoctor())
						return
					case '/pair':
						this.#sendJson(res, 200, await this.#handlePair(body))
						return
					case '/run':
						this.#sendJson(res, 200, await this.#handleRun(body))
						return
					case '/status':
						this.#sendJson(res, 200, await this.#handleStatus(body))
						return
					case '/stop':
						this.#sendJson(res, 200, await this.#handleStop(body))
						return
					default:
						this.#sendJson(
							res,
							404,
							createFailureResult(
								'unknown',
								'invalid_payload',
								`Unknown helper endpoint: ${pathname}`
							)
						)
				}
			} catch (error) {
				this.#sendJson(
					res,
					500,
					createFailureResult(
						'unknown',
						'execution_error',
						error instanceof Error ? error.message : 'Unexpected helper error.'
					)
				)
			}
		})

		await onceHttpListening(this.#controlServer, hostname, port)
	}

	async #handleDoctor() {
		let helloPayload = null

		if (this.#isExtensionConnected()) {
			const helloResponse = await this.#sendExtensionRequest('hello', {
				client: 'companion-dev-helper',
				instanceId: this.#state.pairing.instanceId,
				protocolVersion: '0.1.0',
			})

			if (helloResponse.ok && helloResponse.envelope.type === 'ack') {
				helloPayload = helloResponse.envelope.payload
				this.#state.connection.protocolVersion = helloPayload.protocolVersion
				this.#state.connection.capabilities = helloPayload.capabilities ?? []
				this.#persistState()
			}
		}

		return createSuccessResult('doctor', {
			helper: {
				status: 'running',
				version: HELPER_VERSION,
				controlUrl: this.#controlUrl.toString(),
				helperUrl: this.#helperUrl.toString(),
			},
			extension: {
				status: this.#state.connection.state,
				connected: this.#isExtensionConnected(),
				protocolVersion:
					helloPayload?.protocolVersion ?? this.#state.connection.protocolVersion ?? null,
				capabilities: helloPayload?.capabilities ?? this.#state.connection.capabilities ?? [],
				lastSeenAt: this.#state.connection.lastSeenAt,
			},
			pairing: {
				paired: this.#state.pairing.paired,
				pairedAt: this.#state.pairing.pairedAt,
				instanceId: this.#state.pairing.instanceId,
			},
			currentTaskId: this.#state.currentTaskId,
			currentTask: this.#state.currentTask,
		})
	}

	async #handlePair(body) {
		const pairToken =
			typeof body.pairToken === 'string' && body.pairToken.trim().length > 0
				? body.pairToken
				: randomUUID()

		const response = await this.#sendExtensionRequest('pair', { pairToken })
		if (!response.ok) {
			return createFailureResult('pair', response.code, response.message)
		}

		if (response.envelope.type !== 'ack') {
			return createFailureResult('pair', 'execution_error', 'Unexpected pair response.')
		}

		this.#state.pairing = {
			paired: true,
			pairedAt: new Date().toISOString(),
			instanceId: this.#state.pairing.instanceId ?? DEFAULT_INSTANCE_ID,
			pairToken,
		}
		this.#persistState()

		return createSuccessResult('pair', {
			paired: true,
			pairedAt: this.#state.pairing.pairedAt,
			instanceId: this.#state.pairing.instanceId,
			pairToken,
		})
	}

	async #handleRun(body) {
		const payload = sanitizeRunPayload(body)
		if (!payload.ok) {
			return createFailureResult('run', 'invalid_payload', payload.message)
		}

		const response = await this.#sendExtensionRequest('run', payload.value)
		if (!response.ok) {
			return createFailureResult('run', response.code, response.message)
		}

		if (response.envelope.type !== 'status') {
			return createFailureResult('run', 'execution_error', 'Unexpected run response envelope.')
		}

		this.#updateTaskSnapshot(response.envelope.payload.task)

		return createSuccessResult('run', {
			taskId: response.envelope.payload.task.taskId,
			status: response.envelope.payload.task.status,
			lastError: response.envelope.payload.task.lastError,
			lastSeenAt: response.envelope.payload.task.lastSeenAt,
		})
	}

	async #handleStatus(body) {
		const taskId =
			typeof body.taskId === 'string' && body.taskId.trim().length > 0 ? body.taskId : undefined

		const response = await this.#sendExtensionRequest('status', {
			taskId,
		})
		if (!response.ok) {
			return createFailureResult('status', response.code, response.message)
		}

		if (response.envelope.type !== 'status') {
			return createFailureResult(
				'status',
				'execution_error',
				'Unexpected status response envelope.'
			)
		}

		this.#updateTaskSnapshot(response.envelope.payload.task)

		return createSuccessResult('status', {
			taskId: response.envelope.payload.task.taskId,
			status: response.envelope.payload.task.status,
			lastError: response.envelope.payload.task.lastError,
			lastSeenAt: response.envelope.payload.task.lastSeenAt,
			connectionState: response.envelope.payload.connectionState,
			paired: response.envelope.payload.paired,
			protocolVersion: response.envelope.payload.protocolVersion,
			lastActivity: this.#state.currentTask?.lastActivity ?? null,
			result: this.#state.currentTask?.result ?? null,
		})
	}

	async #handleStop(body) {
		const taskId =
			typeof body.taskId === 'string' && body.taskId.trim().length > 0 ? body.taskId : undefined

		const response = await this.#sendExtensionRequest('stop', {
			taskId,
		})
		if (!response.ok) {
			return createFailureResult('stop', response.code, response.message)
		}

		if (response.envelope.type !== 'status') {
			return createFailureResult('stop', 'execution_error', 'Unexpected stop response envelope.')
		}

		this.#updateTaskSnapshot(response.envelope.payload.task)

		return createSuccessResult('stop', {
			taskId: response.envelope.payload.task.taskId,
			status: response.envelope.payload.task.status,
			lastError: response.envelope.payload.task.lastError,
			lastSeenAt: response.envelope.payload.task.lastSeenAt,
		})
	}

	async #sendExtensionRequest(type, payload) {
		if (!this.#isExtensionConnected()) {
			return {
				ok: false,
				code: 'extension_offline',
				message: 'The browser extension is not connected to the helper.',
			}
		}

		const requestId = randomUUID()

		try {
			const envelope = await new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					this.#pendingRequests.delete(requestId)
					reject(new Error(`Timed out waiting for ${type} response.`))
				}, DEFAULT_TIMEOUT_MS)

				this.#pendingRequests.set(requestId, {
					resolve,
					reject,
					timer,
					type,
				})

				this.#extensionSocket.send(
					JSON.stringify({
						type,
						requestId,
						payload,
					}),
					(error) => {
						if (!error) return

						clearTimeout(timer)
						this.#pendingRequests.delete(requestId)
						reject(error)
					}
				)
			})

			if (envelope.type === 'error') {
				return {
					ok: false,
					code: envelope.payload.code,
					message: envelope.payload.message,
					envelope,
				}
			}

			return {
				ok: true,
				envelope,
			}
		} catch (error) {
			return {
				ok: false,
				code: 'execution_error',
				message: error instanceof Error ? error.message : `Failed to send ${type} request.`,
			}
		}
	}

	#handleExtensionMessage(data) {
		let message

		try {
			message = JSON.parse(data.toString())
		} catch {
			this.#recordError('invalid_message', 'Received non-JSON payload from extension.')
			return
		}

		if (message.type === 'ping') {
			this.#touchConnection()
			return
		}

		if (typeof message.requestId === 'string' && this.#pendingRequests.has(message.requestId)) {
			const pending = this.#pendingRequests.get(message.requestId)
			clearTimeout(pending.timer)
			this.#pendingRequests.delete(message.requestId)
			pending.resolve(message)
			this.#touchConnection()
			return
		}

		this.#touchConnection()

		switch (message.type) {
			case 'status_changed':
				this.#handleStatusChangedEvent(message.payload)
				return
			case 'activity':
				this.#handleActivityEvent(message.payload)
				return
			case 'result':
				this.#handleResultEvent(message.payload)
				return
			default:
				this.#logDebug(`Ignoring unsolicited message type: ${String(message.type)}`)
		}
	}

	#handleStatusChangedEvent(payload) {
		const task = ensureTaskState(this.#state, payload.taskId)
		task.status = payload.status
		task.lastError = payload.lastError
		task.updatedAt = toIsoString(payload.lastSeenAt)
		this.#state.currentTaskId = payload.taskId
		this.#persistState()

		this.#logInfo(`Event status_changed: task=${payload.taskId ?? 'null'} status=${payload.status}`)
	}

	#handleActivityEvent(payload) {
		const task = ensureTaskState(this.#state, payload.taskId)
		task.lastActivity = payload.activity
		task.updatedAt = toIsoString(payload.lastSeenAt)
		this.#state.currentTaskId = payload.taskId
		this.#persistState()

		this.#logInfo(
			`Event activity: task=${payload.taskId ?? 'null'} type=${payload.activity?.type ?? 'unknown'}`
		)
	}

	#handleResultEvent(payload) {
		const task = ensureTaskState(this.#state, payload.taskId)
		task.status = payload.status
		task.lastError = payload.lastError
		task.result = payload
		task.updatedAt = toIsoString(payload.lastSeenAt)
		this.#state.currentTaskId = payload.taskId
		this.#persistState()

		this.#logInfo(
			`Event result: task=${payload.taskId ?? 'null'} success=${String(payload.success)}`
		)
	}

	#updateTaskSnapshot(snapshot) {
		const task = ensureTaskState(this.#state, snapshot.taskId)
		task.status = snapshot.status
		task.lastError = snapshot.lastError
		task.updatedAt = toIsoString(snapshot.lastSeenAt)
		this.#state.currentTaskId = snapshot.taskId
		this.#persistState()
	}

	#setConnectionState(state) {
		this.#state.connection.state = state
		this.#state.connection.lastSeenAt = new Date().toISOString()
		this.#persistState()
	}

	#touchConnection() {
		this.#state.connection.lastSeenAt = new Date().toISOString()
		this.#persistState()
	}

	#isExtensionConnected() {
		return Boolean(this.#extensionSocket && this.#extensionSocket.readyState === WebSocket.OPEN)
	}

	#persistState() {
		saveHelperState(this.#stateFile, this.#state)
	}

	#recordError(code, message) {
		this.#state.recentErrors.unshift({
			code,
			message,
			timestamp: new Date().toISOString(),
		})
		this.#state.recentErrors = this.#state.recentErrors.slice(0, MAX_RECENT_ERRORS)
		this.#persistState()
		this.#logWarn(`${code}: ${message}`)
	}

	#sendJson(res, statusCode, payload) {
		res.statusCode = statusCode
		res.setHeader('content-type', 'application/json; charset=utf-8')
		res.end(JSON.stringify(payload))
	}

	#printStartupSummary() {
		console.log(chalk.cyan.bold('\nCompanion Dev Helper\n'))
		console.log(`${chalk.green('WS')}:      ${this.#helperUrl.toString()}`)
		console.log(`${chalk.green('Control')}: ${this.#controlUrl.toString()}`)
		console.log(`${chalk.green('State')}:   ${this.#stateFile}`)
		console.log(
			chalk.dim(
				'\nUse `node scripts/companion-dev-helper.js doctor --json` to verify the helper.\n'
			)
		)
	}

	#logInfo(message) {
		console.log(`${chalk.green('[helper]')} ${message}`)
	}

	#logWarn(message) {
		console.warn(`${chalk.yellow('[helper]')} ${message}`)
	}

	#logDebug(message) {
		console.debug(`${chalk.dim('[helper]')} ${message}`)
	}
}

function parseArgs(argv) {
	const flags = {}
	const positionals = []

	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index]

		if (!value.startsWith('--')) {
			positionals.push(value)
			continue
		}

		const key = value.slice(2)
		const nextValue = argv[index + 1]

		if (!nextValue || nextValue.startsWith('--')) {
			flags[key] = true
			continue
		}

		flags[key] = nextValue
		index += 1
	}

	return {
		flags,
		positionals,
	}
}

function loadHelperState(stateFile) {
	const fallback = createDefaultState()

	if (!existsSync(stateFile)) {
		return fallback
	}

	try {
		const content = readFileSync(stateFile, 'utf-8')
		const parsed = JSON.parse(content)

		return {
			...fallback,
			...parsed,
			pairing: {
				...fallback.pairing,
				...(parsed.pairing ?? {}),
			},
			connection: {
				...fallback.connection,
				...(parsed.connection ?? {}),
			},
			currentTask: parsed.currentTask ?? null,
			recentErrors: Array.isArray(parsed.recentErrors) ? parsed.recentErrors : [],
		}
	} catch {
		return fallback
	}
}

function saveHelperState(stateFile, state) {
	mkdirSync(dirname(stateFile), { recursive: true })
	writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n')
}

function createDefaultState() {
	return {
		helperVersion: HELPER_VERSION,
		pairing: {
			paired: false,
			pairedAt: null,
			instanceId: DEFAULT_INSTANCE_ID,
			pairToken: null,
		},
		connection: {
			state: 'disconnected',
			lastSeenAt: null,
			protocolVersion: null,
			capabilities: [],
		},
		currentTaskId: null,
		currentTask: null,
		recentErrors: [],
	}
}

function ensureTaskState(state, taskId) {
	if (!state.currentTask || state.currentTask.taskId !== taskId) {
		state.currentTask = {
			taskId,
			status: 'idle',
			lastError: null,
			lastActivity: null,
			result: null,
			updatedAt: null,
		}
	}

	return state.currentTask
}

function sanitizeRunPayload(value) {
	if (!isPlainObject(value)) {
		return {
			ok: false,
			message: 'run requires a JSON object payload.',
		}
	}

	if (typeof value.task !== 'string' || value.task.trim().length === 0) {
		return {
			ok: false,
			message: 'run payload must include a non-empty task.',
		}
	}

	return {
		ok: true,
		value: {
			taskId:
				typeof value.taskId === 'string' && value.taskId.trim().length > 0
					? value.taskId
					: randomUUID(),
			task: value.task,
			llm: isPlainObject(value.llm) ? value.llm : undefined,
			options: isPlainObject(value.options) ? value.options : undefined,
		},
	}
}

function normalizeListenUrl(url) {
	return {
		hostname: url.hostname || '127.0.0.1',
		port: Number(url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80)),
		pathname: url.pathname && url.pathname !== '/' ? url.pathname : undefined,
	}
}

function deriveControlUrl(helperUrl) {
	const url = new URL(helperUrl)
	const port = Number(url.port || '17888')
	return `http://${url.hostname}:${port + 1}`
}

function isPlainObject(value) {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function createSuccessResult(commandName, data) {
	return {
		ok: true,
		command: commandName,
		timestamp: new Date().toISOString(),
		data,
	}
}

function createFailureResult(commandName, code, message) {
	return {
		ok: false,
		command: commandName,
		timestamp: new Date().toISOString(),
		error: {
			code,
			message,
		},
	}
}

function printCommandResult(result) {
	if (result.ok) {
		console.log(chalk.green(`✓ ${result.command}`))
		console.log(JSON.stringify(result.data, null, 2))
		return
	}

	console.error(chalk.red(`✗ ${result.command}`))
	console.error(`${result.error.code}: ${result.error.message}`)
}

function getExitCode(result) {
	if (result.ok) return 0
	if (result.error.code === 'helper_unavailable' || result.error.code === 'extension_offline') {
		return 2
	}
	if (result.error.code === 'timeout') {
		return 3
	}
	return 1
}

function toIsoString(value) {
	if (typeof value === 'string') return value
	if (typeof value === 'number' && Number.isFinite(value)) {
		return new Date(value).toISOString()
	}
	return new Date().toISOString()
}

async function readJsonBody(req) {
	const chunks = []

	for await (const chunk of req) {
		chunks.push(chunk)
	}

	if (chunks.length === 0) {
		return {}
	}

	const text = Buffer.concat(chunks).toString('utf-8')
	return text.trim().length === 0 ? {} : JSON.parse(text)
}

function onceServerListening(server) {
	return new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
	})
}

function onceHttpListening(server, host, port) {
	return new Promise((resolve, reject) => {
		server.once('listening', resolve)
		server.once('error', reject)
		server.listen(port, host)
	})
}

function printHelp() {
	console.log(`Usage: node scripts/companion-dev-helper.js <command> [options]

Commands:
  serve                         Start the local companion helper service
  doctor [--json]               Inspect helper and extension connectivity
  pair [--token <value>]        Pair the helper with the connected extension
  run --task-file <path>        Send a run request from a JSON task file
  status [--task-id <id>]       Query the latest task status
  stop [--task-id <id>]         Stop the active task

Global options:
  --helper-url <ws-url>         WebSocket bind URL for the helper service
  --control-url <http-url>      HTTP control URL used by CLI commands
  --state-file <path>           Override the helper state file path
  --timeout <ms>                Control request timeout in milliseconds
  --json                        Print JSON output for command responses
`)
}

await main()

async function main() {
	try {
		switch (command) {
			case 'serve':
				await runServeCommand({
					helperUrl,
					controlUrl,
					stateFile,
				})
				return
			case 'doctor':
				await runClientCommand('doctor', {
					controlUrl,
					timeoutMs,
					jsonOutput,
					body: {},
				})
				return
			case 'pair':
				await runClientCommand('pair', {
					controlUrl,
					timeoutMs,
					jsonOutput,
					body: {
						pairToken: parsedArgs.flags.token,
					},
				})
				return
			case 'run':
				await runClientCommand('run', {
					controlUrl,
					timeoutMs,
					jsonOutput,
					body: await loadRunPayload(parsedArgs),
				})
				return
			case 'status':
				await runClientCommand('status', {
					controlUrl,
					timeoutMs,
					jsonOutput,
					body: {
						taskId: parsedArgs.flags['task-id'] ?? null,
					},
				})
				return
			case 'stop':
				await runClientCommand('stop', {
					controlUrl,
					timeoutMs,
					jsonOutput,
					body: {
						taskId: parsedArgs.flags['task-id'] ?? null,
					},
				})
				return
			case 'help':
			default:
				printHelp()
				return
		}
	} catch (error) {
		const result = createFailureResult(
			command,
			'invalid_payload',
			error instanceof Error ? error.message : 'Unexpected command error.'
		)

		if (jsonOutput) {
			console.log(JSON.stringify(result, null, 2))
		} else {
			printCommandResult(result)
		}

		process.exitCode = getExitCode(result)
	}
}
