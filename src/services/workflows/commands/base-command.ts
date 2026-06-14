import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import { safeParseJSON } from '../workflow-utils'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string, 
    systemPrompt: string, 
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext
  ): Promise<string> {
    const llmStore = useLLMStore.getState()
    if (!llmStore.defaultModelId) throw new Error('未配置默认 AI 模型')

    callbacks.setProgress(10)

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error('工作流已取消'))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效
            if (context?.cancelled) {
              reject(new Error('工作流已取消'))
              return
            }
            callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            resolve(cleaned)
          },
          onError: (err) => {
            cleanup()
            reject(new Error(err || '流式生成失败'))
          }
        },
        undefined,
        options
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error('工作流已取消'))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean },
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  }

  /**
   * 全局容错 JSON 解析器
   * 自动剥离 Markdown ```json 代码块并处理尾随逗号等常见大模型幻觉
   */
  protected parseJSON<T>(text: string): T {
    return safeParseJSON<T>(text)
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(resources: EventPayloadMap['REFRESH_RESOURCE']['resources']) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources })
  }
}

