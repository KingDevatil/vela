import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate, renderPrompt } from '../../prompt-templates'
import type { NovelConfig } from '../../../shared/ipc-channels'

/**
 * 支持的单字段生成 Key
 * 每个 key 对应 NovelConfig 中的一个文本字段
 */
export type GeneratableField =
  | 'coreOutline'
  | 'worldSetting'
  | 'goldenFinger'
  | 'protagonistProfile'
  | 'globalGuidance'
  | 'writingStyle'

/** 字段中文标签映射 */
const FIELD_LABELS: Record<GeneratableField, string> = {
  coreOutline: '核心大纲',
  worldSetting: '世界观设定',
  goldenFinger: '金手指/核心卖点',
  protagonistProfile: '主角人设',
  globalGuidance: '全局写作要求',
  writingStyle: '文风配置',
}

/** 字段到模板 Key 的映射 */
const FIELD_TEMPLATE_KEY: Record<GeneratableField, string> = {
  coreOutline: 'generate_core_outline',
  worldSetting: 'generate_world_setting',
  goldenFinger: 'generate_golden_finger',
  protagonistProfile: 'generate_protagonist_profile',
  globalGuidance: 'generate_global_guidance',
  writingStyle: 'generate_writing_style',
}

/**
 * 单字段 AI 生成命令
 * 根据已有的 NovelConfig 上下文，只生成指定字段的内容
 */
export class GenerateFieldCommand extends BaseWorkflowCommand<string> {
  constructor(private fieldKey: GeneratableField) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error('未打开项目')

    const config = project.novelConfig
    const label = FIELD_LABELS[this.fieldKey]

    callbacks.log(`🧠 正在为「${label}」生成内容...`)

    // 获取模板
    const templateKey = FIELD_TEMPLATE_KEY[this.fieldKey]
    const template = getPromptTemplate(templateKey)
    if (!template) {
      throw new Error(`未找到模板：${templateKey}`)
    }

    // 构建上下文摘要（已填写的字段作为参考）
    const context = this.buildContext(config)
    const currentContent = this.getCurrentFieldValue(config)

    // 构建变量
    const variables: Record<string, string> = {
      context,
      current_content: currentContent,
      genre: config.genre || '未指定',
      target_audience: config.targetAudience || '未指定',
      total_chapters: String(config.totalChapters || 100),
    }

    // 渲染模板
    let prompt = renderPrompt(template, variables)

    // 如果当前字段已有内容，追加基于已有内容的指导
    if (currentContent) {
      prompt += `

【重要】用户已经为「${label}」编写了以下内容：
---
${currentContent}
---

请基于用户已有的内容进行扩展和完善，保留用户的核心想法和设定，补充缺失的部分，使内容更加完整和专业。不要完全推翻用户已有的内容。`
    } else {
      prompt += `

【输出要求】
- 直接输出纯文本内容，不要使用 JSON 格式
- 不要添加任何前导语、解释或客套话
- 不要使用 Markdown 标题（#），可以使用换行分段`
    }

    const systemPrompt = template.systemRole || '你是一位入行十年的顶尖网文主编与白金大神作家，擅长精准设计小说的各项核心配置。'

    const result = await this.callLLM(prompt, systemPrompt, callbacks)
    const cleanResult = this.stripThinkingTags(result).trim()

    if (!cleanResult) {
      callbacks.log(`⚠️ 「${label}」生成返回空结果`)
      return ''
    }

    // 写入 NovelConfig
    const { updateNovelConfig, saveProject } = useProjectStore.getState()
    updateNovelConfig({ [this.fieldKey]: cleanResult })
    await saveProject()
    callbacks.log(`✅ 「${label}」已生成并保存`)

    return cleanResult
  }

  /** 构建已有配置的上下文摘要 */
  private buildContext(config: NovelConfig): string {
    const parts: string[] = []
    if (config.genre) parts.push(`- 类型：${config.genre}`)
    if (config.subGenre) parts.push(`- 细分类型：${config.subGenre}`)
    if (config.targetAudience) parts.push(`- 目标受众：${config.targetAudience}`)
    if (config.totalChapters) parts.push(`- 总章数：${config.totalChapters} 章`)
    if (config.wordsPerChapter) parts.push(`- 每章字数：${config.wordsPerChapter} 字`)
    if (config.coreOutline?.trim() && this.fieldKey !== 'coreOutline')
      parts.push(`- 核心大纲：${config.coreOutline.slice(0, 500)}`)
    if (config.worldSetting?.trim() && this.fieldKey !== 'worldSetting')
      parts.push(`- 世界观设定：${config.worldSetting.slice(0, 500)}`)
    if (config.goldenFinger?.trim() && this.fieldKey !== 'goldenFinger')
      parts.push(`- 金手指体系：${config.goldenFinger.slice(0, 500)}`)
    if (config.protagonistProfile?.trim() && this.fieldKey !== 'protagonistProfile')
      parts.push(`- 主角人设：${config.protagonistProfile.slice(0, 500)}`)
    if (config.globalGuidance?.trim() && this.fieldKey !== 'globalGuidance')
      parts.push(`- 全局写作要求：${config.globalGuidance.slice(0, 500)}`)
    if (config.referenceWorks?.trim())
      parts.push(`- 参考作品：${config.referenceWorks}`)
    if (config.writingStyle?.trim() && this.fieldKey !== 'writingStyle')
      parts.push(`- 文风描述：${config.writingStyle.slice(0, 300)}`)
    return parts.length > 0 ? parts.join('\n') : '（尚未填写任何配置）'
  }

  /** 获取当前字段的已有内容 */
  private getCurrentFieldValue(config: NovelConfig): string {
    const fieldValue = config[this.fieldKey]
    return typeof fieldValue === 'string' ? fieldValue.trim() : ''
  }
}
