import { ILLMProvider, LLMGenerateOptions, LLMResponse, LLMStreamOptions } from './provider.interface'
import { ModelProfile } from '../../src/shared/ipc-channels'

export class AnthropicProvider implements ILLMProvider {
  private buildUrl(baseUrl: string): string {
    const base = baseUrl.replace(/\/$/, '')
    // Anthropic API: https://api.anthropic.com/v1/messages
    if (base.endsWith('/v1/messages')) {
      return base
    }
    if (base.endsWith('/v1')) {
      return `${base}/messages`
    }
    return `${base}/v1/messages`
  }

  private toAnthropicMessages(messages: Array<{ role: string; content: string }>): {
    system?: string
    messages: Array<{ role: string; content: string }>
  } {
    let system: string | undefined
    const filtered = messages.filter((m) => {
      if (m.role === 'system') {
        system = m.content
        return false
      }
      return true
    })
    return { system, messages: filtered }
  }

  async generate(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMGenerateOptions): Promise<LLMResponse> {
    const url = this.buildUrl(model.baseUrl)
    const { system, messages: anthropicMessages } = this.toAnthropicMessages(messages)

    const body: Record<string, unknown> = {
      model: model.modelName,
      max_tokens: opts.maxTokens ?? model.maxTokens,
      messages: anthropicMessages,
    }

    if (system) body.system = system

    if (opts.thinking) {
      body.thinking = { type: 'enabled', budget_tokens: opts.maxTokens ?? model.maxTokens }
    } else {
      body.temperature = opts.temperature ?? model.temperature
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': model.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      return { success: false, content: '', error: `Anthropic API 调用失败 (${res.status}): ${text}` }
    }

    const data = await res.json() as {
      content: Array<{ type: string; text?: string }>
      usage?: { input_tokens: number; output_tokens: number }
    }

    let finalContent = ''
    for (const block of data.content ?? []) {
      if (block.type === 'text' && block.text) {
        finalContent += block.text
      }
    }

    return {
      success: true,
      content: finalContent,
      usage: data.usage ? {
        promptTokens: data.usage.input_tokens,
        completionTokens: data.usage.output_tokens,
        totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      } : undefined,
    }
  }

  async generateStream(model: ModelProfile, messages: Array<{ role: string; content: string }>, opts: LLMStreamOptions): Promise<void> {
    try {
      const url = this.buildUrl(model.baseUrl)
      const { system, messages: anthropicMessages } = this.toAnthropicMessages(messages)

      const body: Record<string, unknown> = {
        model: model.modelName,
        max_tokens: opts.maxTokens ?? model.maxTokens,
        messages: anthropicMessages,
        stream: true,
      }

      if (system) body.system = system

      if (opts.thinking) {
        body.thinking = { type: 'enabled', budget_tokens: opts.maxTokens ?? model.maxTokens }
      } else {
        body.temperature = opts.temperature ?? model.temperature
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': model.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: opts.signal,
      })

      if (!res.ok) {
        const text = await res.text()
        opts.onError(`Anthropic API 调用失败 (${res.status}): ${text}`)
        return
      }

      const reader = res.body?.getReader()
      if (!reader) {
        opts.onError('无法读取响应流')
        return
      }

      const decoder = new TextDecoder()
      let fullText = ''
      let currentType = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const text = decoder.decode(value, { stream: true })
        const lines = text.split('\n').filter((l) => l.startsWith('data: '))

        for (const line of lines) {
          const json = line.slice(6).trim()
          if (json === '[DONE]') continue
          try {
            const parsed = JSON.parse(json) as {
              type: string
              delta?: { type?: string; text?: string }
            }

            if (parsed.type === 'content_block_start') {
              currentType = parsed.delta?.type ?? ''
              if (currentType === 'thinking') {
                opts.onChunk('<think>\n')
              }
            } else if (parsed.type === 'content_block_delta') {
              if (parsed.delta?.text) {
                fullText += parsed.delta.text
                opts.onChunk(parsed.delta.text)
              }
            } else if (parsed.type === 'content_block_stop') {
              if (currentType === 'thinking') {
                opts.onChunk('\n</think>\n\n')
              }
              currentType = ''
            }
          } catch {
            // ignore
          }
        }
      }

      opts.onDone(fullText.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim())
    } catch (error) {
      if ((error as Error).name === 'AbortError') {
        opts.onError('已取消生成')
      } else {
        opts.onError(String(error))
      }
    }
  }
}
