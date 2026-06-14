/**
 * read_architecture — 读取故事架构文件
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { useProjectStore } from '../../../stores/project-store'


export const readArchitectureTool = buildAgentTool({
  name: 'read_architecture',
  description: '读取小说的故事架构数据（存储在数据库中，非文件）。支持四个维度：故事前提、角色图谱、世界观、情节大纲。是理解小说全局结构的核心工具。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: '架构维度（可选）。不填则返回全部。可选值："premise"（故事前提）、"characters"（角色图谱）、"worldbuilding"（世界观）、"synopsis"（情节大纲）',
      },
    },
  },
  requiresConfirmation: false,
  execute: async (args) => {
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: '没有打开的项目' }
    }

    const section = args.section as string | undefined

    try {
      const core = await ipc.invoke('db:project-core-get')
      if (!core) {
        return { success: false, content: '', error: '项目架构未初始化' }
      }

      if (section) {
        const isPremise = section.includes('premise') || section.includes('前提')
        const isWorld = section.includes('world') || section.includes('世界')
        const isChar = section.includes('character') || section.includes('角色')
        const isSynopsis = section.includes('synopsis') || section.includes('大纲')
        let property = ''
        let label = section
        if (isPremise) { property = core.premise; label = '故事前提' }
        else if (isWorld) { property = core.worldbuilding; label = '世界观' }
        else if (isChar) { property = core.charactersArch; label = '角色图谱' }
        else if (isSynopsis) { property = core.synopsis; label = '情节大纲' }

        if (!property) {
          return { success: false, content: '', error: `架构数据为空：${label}` }
        }
        return { success: true, content: `📐 ${label}\n\n${property}` }
      }

      const contents: string[] = []
      if (core.premise) contents.push(`## 📄 故事前提\n\n${core.premise}`)
      if (core.charactersArch) contents.push(`## 📄 角色图谱\n\n${core.charactersArch}`)
      if (core.worldbuilding) contents.push(`## 📄 世界观\n\n${core.worldbuilding}`)
      if (core.synopsis) contents.push(`## 📄 情节大纲\n\n${core.synopsis}`)

      if (contents.length === 0) {
        return { success: true, content: '⚠️ 架构为空，暂无架构数据。建议通过工作流生成故事架构。' }
      }

      return { success: true, content: `📐 故事架构（${contents.length} 个维度）\n\n${contents.join('\n\n---\n\n')}` }
    } catch (error) {
      return { success: false, content: '', error: `读取架构失败：${String(error)}` }
    }
  },
})
