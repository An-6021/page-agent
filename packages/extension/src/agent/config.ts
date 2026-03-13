import type { SupportedLanguage } from '@page-agent/core'
import type { LLMConfig } from '@page-agent/llms'

import { DEMO_CONFIG, migrateLegacyEndpoint } from './constants'

export type LanguagePreference = SupportedLanguage | undefined

export interface AdvancedConfig {
	maxSteps?: number
	systemInstruction?: string
	experimentalLlmsTxt?: boolean
}

export interface ExtConfig extends LLMConfig, AdvancedConfig {
	language?: LanguagePreference
}

const STORAGE_KEYS = ['llmConfig', 'language', 'advancedConfig'] as const

export async function loadStoredAgentConfig(): Promise<ExtConfig> {
	const result = await chrome.storage.local.get([...STORAGE_KEYS])

	let llmConfig = (result.llmConfig as LLMConfig | undefined) ?? DEMO_CONFIG
	const language = (result.language as SupportedLanguage | undefined) || undefined
	const advancedConfig = (result.advancedConfig as AdvancedConfig | undefined) ?? {}

	const migrated = migrateLegacyEndpoint(llmConfig)
	if (migrated !== llmConfig) {
		llmConfig = migrated
		await chrome.storage.local.set({ llmConfig: migrated })
	} else if (!result.llmConfig) {
		await chrome.storage.local.set({ llmConfig: DEMO_CONFIG })
	}

	return {
		...llmConfig,
		...advancedConfig,
		language,
	}
}
