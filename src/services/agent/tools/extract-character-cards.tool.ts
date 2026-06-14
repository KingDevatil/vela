/**
 * extract_character_cards — 从角色图谱提取角色卡
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { useProjectStore } from '../../../stores/project-store'

export const extractCharacterCardsTool = buildAgentTool({
  name: 'extract_character_cards',
  description: '从已生成的角色图谱中提取角色卡数据（写入数据库）。仅在角色图谱已生成但角色卡为空时使用。此操作会触发 AI 提取流水线，需要一些时间完成。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  requiresConfirmation: true,
  execute: async (_args) => {
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: '没有打开的项目' }
    }

    try {
      // 检查角色卡是否已有数据
      const existingChars = await ipc.invoke('db:character-get-all')
      if (Array.isArray(existingChars) && existingChars.length > 0) {
        return {
          success: true,
          content: `ℹ️ 角色卡已存在（共 ${existingChars.length} 个角色），无需重新提取。如需修改请使用角色管理面板手动编辑。`,
        }
      }

      // 读取角色图谱内容
      const core = await ipc.invoke('db:project-core-get')
      const charArch = core?.charactersArch ?? ''
      if (charArch.length < 50) {
        return {
          success: false,
          content: '',
          error: '角色图谱尚未生成或内容为空。请先通过「生成架构」工作流生成角色图谱。',
        }
      }

      // 触发角色卡提取流水线
      const { runArchCharacterExtract } = await import('../../workflows/architecture-workflow')
      runArchCharacterExtract(project.path, charArch, project.novelConfig.genre)

      return {
        success: true,
        content: '🚀 已触发角色卡提取流水线。AI 正在从角色图谱中提取结构化角色数据，完成后角色列表将自动更新。请在「角色管理」面板查看结果。',
        artifacts: [{ type: 'workflow_started', name: '角色卡提取' }],
      }
    } catch (error) {
      return { success: false, content: '', error: `角色卡提取失败：${String(error)}` }
    }
  },
})
