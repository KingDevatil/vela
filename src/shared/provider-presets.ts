/**
 * 服务商预设配置 — 共享类型定义
 * 渲染进程与主进程共同使用，持久化在 ~/.vela/provider-presets.json
 *
 * 拆分为两大类：
 * - CHAT_PROVIDER_PRESETS: AI 生成模型服务商（Chat Completion）
 * - EMBEDDING_PROVIDER_PRESETS: 向量模型服务商（Embedding）
 */

/** 单个模型的预设 — name + 该模型的输出 token 上限 */
export interface ModelPreset {
  name: string
  maxTokens: number
}

/** 服务商类型 */
export type ProviderType = 'chat' | 'embedding' | 'both'

/** 单个服务商的预设配置 */
export interface ProviderPreset {
  /** 服务商唯一标识（内置值如 openai/deepseek，用户可自定义如 my-proxy） */
  provider: string
  /** 界面显示名称，缺省时使用 provider ID */
  displayName?: string
  /** 默认 API 地址 */
  baseUrl: string
  /** 默认调用协议：openai 兼容 / gemini 原生 / anthropic 兼容 */
  protocol: 'openai' | 'gemini' | 'anthropic'
  /** 支持的生成模型列表（含各自的 maxTokens） */
  models: ModelPreset[]
  /** 支持的向量模型列表（embedding 模型不需要 maxTokens） */
  embeddingModels: string[]
}

// ============================================================================
// AI 生成模型服务商（Chat Completion）
// ============================================================================

export const CHAT_PROVIDER_PRESETS: ProviderPreset[] = [
  // ---- 国际 ----
  {
    provider: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    models: [
      { name: 'gpt-5.1', maxTokens: 16384 },
      { name: 'gpt-4o', maxTokens: 16384 },
      { name: 'gpt-4o-mini', maxTokens: 16384 },
      { name: 'o3', maxTokens: 32768 },
      { name: 'o3-mini', maxTokens: 32768 },
      { name: 'o4-mini', maxTokens: 32768 },
      { name: 'o1', maxTokens: 32768 },
      { name: 'o1-mini', maxTokens: 32768 },
    ],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    provider: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    protocol: 'anthropic',
    models: [
      { name: 'claude-opus-4-7', maxTokens: 16384 },
      { name: 'claude-sonnet-4-6', maxTokens: 16384 },
      { name: 'claude-haiku-4-5-20251001', maxTokens: 8192 },
    ],
    embeddingModels: [],
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    models: [
      { name: 'gemini-2.5-pro', maxTokens: 65536 },
      { name: 'gemini-2.5-flash', maxTokens: 65536 },
      { name: 'gemini-2.0-flash', maxTokens: 8192 },
      { name: 'gemini-2.0-flash-lite', maxTokens: 8192 },
    ],
    embeddingModels: ['text-embedding-004'],
  },

  // ---- 国内 ----
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    models: [
      { name: 'deepseek-v4-pro', maxTokens: 65536 },
      { name: 'deepseek-v4-flash', maxTokens: 65536 },
    ],
    embeddingModels: ['deepseek-embedding'],
  },
  {
    provider: 'bigmodel',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [
      { name: 'glm-5.1', maxTokens: 128000 },
      { name: 'glm-5', maxTokens: 128000 },
      { name: 'glm-5-turbo', maxTokens: 128000 },
      { name: 'glm-4.7', maxTokens: 128000 },
      { name: 'glm-4.7-flash', maxTokens: 128000 },
      { name: 'glm-4.7-flashx', maxTokens: 128000 },
      { name: 'glm-4.6', maxTokens: 128000 },
      { name: 'glm-4.5-air', maxTokens: 96000 },
      { name: 'glm-4.5-airx', maxTokens: 96000 },
      { name: 'glm-4-long', maxTokens: 4096 },
    ],
    embeddingModels: ['embedding-3'],
  },
  {
    provider: 'minimax',
    displayName: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/v1',
    protocol: 'openai',
    models: [
      { name: 'MiniMax-M3', maxTokens: 65536 },
      { name: 'MiniMax-M2.7', maxTokens: 32768 },
      { name: 'MiniMax-M2.5', maxTokens: 32768 },
    ],
    embeddingModels: [],
  },
  {
    provider: 'siliconflow',
    displayName: 'SiliconFlow（硅基流动）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    models: [
      { name: 'deepseek-ai/DeepSeek-V3', maxTokens: 65536 },
      { name: 'deepseek-ai/DeepSeek-R1', maxTokens: 65536 },
      { name: 'Qwen/Qwen3-235B-A22B', maxTokens: 65536 },
      { name: 'Qwen/Qwen3-32B', maxTokens: 65536 },
      { name: 'Qwen/Qwen3-8B', maxTokens: 65536 },
    ],
    embeddingModels: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'BAAI/bge-large-en-v1.5'],
  },
  {
    provider: 'mimo',
    displayName: '小米 MiMO',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    protocol: 'openai',
    models: [
      { name: 'mimo-v2.5-pro', maxTokens: 8192 },
    ],
    embeddingModels: [],
  },

  // ---- 本地部署 ----
  {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    models: [
      { name: 'llama3.3', maxTokens: 4096 },
      { name: 'llama3.2', maxTokens: 4096 },
      { name: 'qwen2.5', maxTokens: 8192 },
      { name: 'qwen2.5-coder', maxTokens: 8192 },
      { name: 'mistral', maxTokens: 4096 },
      { name: 'phi4', maxTokens: 4096 },
      { name: 'gemma3', maxTokens: 8192 },
      { name: 'MiMo-7B-RL', maxTokens: 8192 },
    ],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3'],
  },
  {
    provider: 'lmstudio',
    displayName: 'LM Studio（本地）',
    baseUrl: 'http://localhost:1234/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: ['nomic-embed-text-v1.5', 'bge-large', 'e5-mistral-7b'],
  },
]

// ============================================================================
// 向量模型服务商（Embedding）— 独立列表，便于在设置界面中单独展示
// ============================================================================

export const EMBEDDING_PROVIDER_PRESETS: ProviderPreset[] = [
  {
    provider: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    protocol: 'openai',
    models: [],
    embeddingModels: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'],
  },
  {
    provider: 'bigmodel',
    displayName: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    protocol: 'openai',
    models: [],
    embeddingModels: ['embedding-3', 'embedding-2'],
  },
  {
    provider: 'gemini',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    protocol: 'gemini',
    models: [],
    embeddingModels: ['text-embedding-004'],
  },
  {
    provider: 'deepseek',
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    protocol: 'openai',
    models: [],
    embeddingModels: ['deepseek-embedding'],
  },
  {
    provider: 'siliconflow',
    displayName: 'SiliconFlow（硅基流动）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: ['BAAI/bge-m3', 'BAAI/bge-large-zh-v1.5', 'BAAI/bge-large-en-v1.5'],
  },
  {
    provider: 'ollama',
    displayName: 'Ollama（本地）',
    baseUrl: 'http://localhost:11434/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: ['nomic-embed-text', 'mxbai-embed-large', 'bge-m3', 'bge-large'],
  },
  {
    provider: 'lmstudio',
    displayName: 'LM Studio（本地）',
    baseUrl: 'http://localhost:1234/v1',
    protocol: 'openai',
    models: [],
    embeddingModels: ['nomic-embed-text-v1.5', 'bge-large', 'e5-mistral-7b'],
  },
]

/** 自定义服务商模板 */
export const CUSTOM_PROVIDER_TEMPLATE: ProviderPreset = {
  provider: 'custom',
  displayName: '自定义',
  baseUrl: '',
  protocol: 'openai',
  models: [],
  embeddingModels: [],
}

/** 向后兼容：合并的预设列表（包含生成和向量模型） */
export const BUILTIN_PRESETS: ProviderPreset[] = CHAT_PROVIDER_PRESETS
