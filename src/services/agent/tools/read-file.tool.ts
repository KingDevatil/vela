/**
 * read_file — 读取项目内的文件内容
 */
import { buildAgentTool } from '../tool-registry'
import { ipc } from '../../ipc-client'
import { useProjectStore } from '../../../stores/project-store'
import { validatePath } from './safe-path'

export const readFileTool = buildAgentTool({
  name: 'read_file',
  description: '读取项目磁盘上的文件内容。仅用于读取实际存在的文件（如 .txt、.md、配置文件等）。注意：故事架构、角色卡、蓝图等数据存储在数据库中，请使用对应的专用工具（read_architecture、read_characters、read_blueprint）而非此工具。',
  source: 'builtin',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '相对于项目根目录的文件路径，例如 "prompts/custom.md"',
      },
    },
    required: ['file_path'],
  },
  requiresConfirmation: false,
  execute: async (args) => {
    const filePath = args.file_path as string
    const project = useProjectStore.getState().currentProject
    if (!project) {
      return { success: false, content: '', error: '没有打开的项目' }
    }

    // 拦截伪协议路径，引导使用正确工具
    if (filePath.startsWith('vela://')) {
      return { success: false, content: '', error: `"${filePath}" 是数据库虚拟路径，不是磁盘文件。请使用 read_architecture 读取架构数据，或 read_characters 读取角色卡。` }
    }

    // 路径安全校验
    const pathCheck = validatePath(project.path, filePath)
    if (!pathCheck.valid) {
      return { success: false, content: '', error: pathCheck.error }
    }

    const result = await ipc.invoke('fs:read-file', pathCheck.fullPath)
    if (!result.success) {
      return { success: false, content: '', error: result.error ?? '文件读取失败' }
    }

    return { success: true, content: result.content }
  },
})
