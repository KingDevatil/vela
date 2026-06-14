/**
 * 工作流共享工具函数
 *
 * 供 architecture-workflow / chapter-workflow 等多个工作流复用的通用逻辑
 *
 * 核心组件：
 * 1. withRetry — 通用异步重试包装器
 * 2. PostProcessPipeline — 后处理流水线（注册 → 执行 → 持久化 → 修复）
 */

import type { StepCallbacks } from '../../stores/workflow-store'
import { ipc } from '../ipc-client'

// ===== 文本处理通用工具 =====

/**
 * 剥除文本中可能包含的 <think>...</think> 思维链标签
 * 用于清洗大模型在生成正文时输出的思维链，避免其被持久化写入磁盘文件
 */
export function stripThinkingTags(text: string): string {
  if (!text) return text
  // 支持只有 <think> 没有闭合标签的情况
  return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
}

/**
 * 容错 JSON 解析 — 专门应对 LLM 输出的各种格式问题
 *
 * 处理策略（按优先级逐级加强）：
 * 1. 剥除 Markdown 代码块 + think 标签
 * 2. 截取有效 JSON 边界（[ ] 或 { }）
 * 3. 规范化中文标点 + 移除注释
 * 4. 修复缺失逗号 + 尾随逗号
 * 5. 修复未加引号的 key
 * 6. 将单引号字符串转为双引号
 * 7. 转义字符串值中的控制字符（换行、Tab）
 * 8. 修复截断的 JSON（补全未闭合的括号/引号）
 * 9. 嵌套片段提取 + 完整修复链重试
 * 10. 终极兜底：基于 token 的 lenient 解析器（只要有 key-value 就能恢复）
 */
export function safeParseJSON<T = unknown>(raw: string): T {
  // 0. 预处理：移除 BOM、智能引号、中文标点规范化
  let text = raw
    .replace(/\uFEFF/g, '')           // 移除 BOM
    .replace(/[\u201C\u201D]/g, '"') // 智能双引号 → 标准双引号
    .replace(/[\u2018\u2019]/g, "'") // 智能单引号 → 标准单引号
    .replace(/\uFF0C/g, ',')          // 全角逗号 → 半角
    .replace(/\u3002/g, '.')          // 中文句号 → 半角
    .replace(/\uFF1A/g, ':')          // 中文冒号 → 半角
    .replace(/\uFF1B/g, ';')          // 中文分号 → 半角
    .replace(/\uFF0C/g, ',')          // 中文逗号 → 半角

  // 1. 剥除 Markdown 代码块 + think 标签
  text = stripThinkingTags(text)
  // 提取代码块内部内容，而非简单剥离标记（防止前后有解释文字时混淆）
  const codeBlockMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/i)
  if (codeBlockMatch) {
    text = codeBlockMatch[1].trim()
  } else {
    // 没有匹配到代码块，执行简单的标记剥离作为兜底
    text = text.replace(/```json?\n?/gi, '').replace(/```\n?/g, '').trim()
  }

  // 2. 截取有效 JSON 边界
  text = extractJsonBoundary(text)

  // 尝试多轮修复，每轮逐步加强
  const errors: string[] = []

  // 第 1 轮：规范化标点 + 基础清理（注释 + 尾随逗号）
  let cleaned = fixMissingCommas(removeCommentsAndTrailingCommas(normalizePunctuation(text)))
  try { return JSON.parse(cleaned) as T } catch (e) { errors.push(String(e)) }

  // 第 2 轮：修复未加引号的 key
  cleaned = fixUnquotedKeys(cleaned)
  try { return JSON.parse(cleaned) as T } catch (e) { errors.push(String(e)) }

  // 第 3 轮：将单引号字符串转为双引号
  cleaned = fixSingleQuotedStrings(cleaned)
  try { return JSON.parse(cleaned) as T } catch (e) { errors.push(String(e)) }

  // 第 4 轮：转义字符串值中的控制字符（换行/Tab）
  cleaned = escapeControlCharsInStrings(cleaned)
  try { return JSON.parse(cleaned) as T } catch (e) { errors.push(String(e)) }

  // 第 5 轮：修复截断的 JSON（补全未闭合的括号/引号）
  cleaned = repairTruncatedJson(cleaned)
  try { return JSON.parse(cleaned) as T } catch (e) { errors.push(String(e)) }

  // 第 6 轮：尝试提取嵌套在冗余文本中的最大有效 JSON 片段
  const extracted = extractLargestValidJson<T>(text)
  if (extracted !== undefined) return extracted

  // 第 7 轮：终极兜底 — 基于 token 扫描的 lenient 解析器
  // 只要能识别出基本的 key-value 对就能恢复有效 JSON
  const lenient = lenientJsonRecovery<T>(text)
  if (lenient !== undefined) return lenient

  // 全部策略失败，抛出详细错误
  throw new Error(
    `JSON 解析失败，已尝试 7 轮修复策略均无效（含 lenient 兜底）。\n` +
    `错误链：${errors.join(' → ')}\n` +
    `内容前 300 字符：${text.slice(0, 300)}`
  )
}

// ---------- safeParseJSON 内部修复函数 ----------

/** 规范化文本中的非标准标点为 JSON 兼容标点 */
function normalizePunctuation(text: string): string {
  return text
    .replace(/\uFF1A/g, ':')   // 全角冒号 → 半角
    .replace(/\uFF0C/g, ',')   // 全角逗号 → 半角
    .replace(/\uFF1B/g, ';')   // 全角分号 → 半角
    .replace(/\u3001/g, ',')   // 顿号 → 逗号
}

/**
 * 移除注释 + 尾随逗号
 * 
 * 注释移除感知字符串上下文，不会剥除引号内的行注释或块注释符号
 */
function removeCommentsAndTrailingCommas(text: string): string {
  let result = ''
  let i = 0

  while (i < text.length) {
    const ch = text[i]

    // 在字符串内部：原样保留所有字符（包括 // 和 /*）
    if (ch === '"' || ch === "'") {
      const quote = ch
      result += ch
      i++
      while (i < text.length) {
        if (text[i] === '\\') {
          result += text[i] + (text[i + 1] || '')
          i += 2
        } else if (text[i] === quote) {
          result += text[i]
          i++
          break
        } else {
          result += text[i]
          i++
        }
      }
      continue
    }

    // 单行注释：// ...
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
      // 跳到行尾
      while (i < text.length && text[i] !== '\n') i++
      continue
    }

    // 块注释：/* ... */
    if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
      i += 2
      while (i < text.length - 1) {
        if (text[i] === '*' && text[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      // 处理未闭合的块注释（截断场景）
      if (i >= text.length - 1) i = text.length
      continue
    }

    result += ch
    i++
  }

  // 反复清理尾随逗号
  let prev = ''
  while (prev !== result) {
    prev = result
    result = result.replace(/,\s*([\]}])/g, '$1')
  }
  return result
}

/**
 * 修复 JSON 中缺失的逗号
 * 
 * 仅处理“安全”的括号间转换（不会误伤字符串内部的空格）：
 *   } {  →  }, {
 *   ] [  →  ], [
 *   } [  →  }, [
 *   ] {  →  ], {
 * 
 * 注：字符串间的缺失逗号（"v1" "k2": ...）由 LenientParser 处理，
 * 它能在解析时自动跳过缺失逗号的情况。
 */
function fixMissingCommas(text: string): string {
  let result = text
  // } {  →  }, {
  result = result.replace(/}\s*\{/g, '}, {')
  // ] [  →  ], [
  result = result.replace(/]\s*\[/g, '], [')
  // } [  →  }, [
  result = result.replace(/}\s*\[/g, '}, [')
  // ] {  →  ], {
  result = result.replace(/]\s*\{/g, '], {')
  return result
}

/** 修复未加引号的 key：{name: "value"} → {"name": "value"} */
function fixUnquotedKeys(text: string): string {
  // 匹配 { 或 , 后面跟着的未加引号的标识符作为 key
  return text.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":')
}

/** 将单引号字符串转为双引号（简单启发式） */
function fixSingleQuotedStrings(text: string): string {
  // 仅当文本中不含任何双引号时才做替换，避免破坏已有的双引号字符串
  if (text.includes('"')) return text
  return text.replace(/'/g, '"')
}

/** 转义双引号字符串值中的控制字符（\n, \r, \t） */
function escapeControlCharsInStrings(text: string): string {
  // 遍历文本，找到双引号字符串并转义内部的控制字符
  let result = ''
  let i = 0
  while (i < text.length) {
    if (text[i] === '"') {
      // 开始一个字符串
      result += '"'
      i++
      while (i < text.length && text[i] !== '"') {
        if (text[i] === '\\') {
          // 已有的转义序列，原样保留
          result += text[i] + (text[i + 1] || '')
          i += 2
        } else if (text[i] === '\n') {
          result += '\\n'
          i++
        } else if (text[i] === '\r') {
          result += '\\r'
          i++
        } else if (text[i] === '\t') {
          result += '\\t'
          i++
        } else {
          result += text[i]
          i++
        }
      }
      if (i < text.length) {
        result += '"'
        i++
      }
    } else {
      result += text[i]
      i++
    }
  }
  return result
}

/**
 * 智能截取 JSON 边界
 * 
 * 比简单的 indexOf/lastIndexOf 更健壮：
 * - 跳过字符串内部出现的括号
 * - 处理 LLM 在 JSON 前后添加解释文字的情况
 */
function extractJsonBoundary(text: string): string {
  // 尝试找数组或对象的起始位置
  const arrayStart = findJsonStart(text, '[')
  const objectStart = findJsonStart(text, '{')

  let start = -1
  let endChar = ''

  if (arrayStart !== -1 && (objectStart === -1 || arrayStart < objectStart)) {
    start = arrayStart
    endChar = ']'
  } else if (objectStart !== -1) {
    start = objectStart
    endChar = '}'
  }

  if (start === -1) return text

  // 从 start 开始，逐字符扫描找到匹配的闭合符号（跳过字符串内部）
  let depth = 0
  let inString = false
  let escape = false
  let end = -1  // -1 表示未找到匹配闭合符（截断场景）

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === (endChar === ']' ? '[' : '{')) {
      depth++
    } else if (ch === endChar) {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }

  // 找到匹配的闭合符：截取完整 JSON
  // 未找到（截断）：返回从起始到文本末尾的全部内容，留给 repairTruncatedJson 补全
  if (end === -1) {
    return text.substring(start)
  }
  return text.substring(start, end + 1)
}

/** 在文本中找到第一个不在字符串内部的指定字符位置 */
function findJsonStart(text: string, char: '{' | '['): number {
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (ch === char) return i
  }
  return -1
}

/**
 * 修复被截断的 JSON（LLM 输出超出 token 限制时常见）
 * 
 * 策略：分析未闭合的括号/引号层级，逐层补全
 */
function repairTruncatedJson(text: string): string {
  let result = text.trimEnd()
  
  // 如果末尾有逗号，先移除（常见截断模式）
  result = result.replace(/,\s*$/, '')

  // 统计未闭合的括号
  let inString = false
  let escape = false
  const stack: string[] = []

  for (let i = 0; i < result.length; i++) {
    const ch = result[i]
    if (escape) {
      escape = false
      continue
    }
    if (ch === '\\' && inString) {
      escape = true
      continue
    }
    if (ch === '"') {
      inString = !inString
      continue
    }
    if (inString) continue

    if (ch === '{' || ch === '[') {
      stack.push(ch)
    } else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '['
      if (stack.length > 0 && stack[stack.length - 1] === expected) {
        stack.pop()
      }
    }
  }

  // 如果字符串未闭合，补全引号
  if (inString) {
    result += '"'
  }

  // 逆序补全未闭合的括号
  for (let i = stack.length - 1; i >= 0; i--) {
    result += stack[i] === '{' ? '}' : ']'
  }

  return result
}

/**
 * 从冗余文本中提取最大的有效 JSON 片段
 * 
 * 用于 LLM 在 JSON 前后添加解释文字、或输出多个 JSON 片段的场景
 * 通过逐段扫描并尝试解析来找到最大的有效 JSON
 */
function extractLargestValidJson<T>(text: string): T | undefined {
  // 扫描所有可能的 JSON 起始位置
  const candidates: string[] = []
  
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' || text[i] === '{') {
      // 从这个位置尝试提取
      const sub = extractJsonBoundary(text.substring(i))
      if (sub.length > 0) {
        candidates.push(sub)
      }
    }
  }

  // 按长度降序排序，优先尝试最大的片段
  candidates.sort((a, b) => b.length - a.length)

  for (const candidate of candidates) {
    // 对每个候选片段应用完整的修复链
    let cleaned = removeCommentsAndTrailingCommas(candidate)
    try { return JSON.parse(cleaned) as T } catch { /* continue */ }

    cleaned = fixUnquotedKeys(cleaned)
    try { return JSON.parse(cleaned) as T } catch { /* continue */ }

    cleaned = fixSingleQuotedStrings(cleaned)
    try { return JSON.parse(cleaned) as T } catch { /* continue */ }

    cleaned = escapeControlCharsInStrings(cleaned)
    try { return JSON.parse(cleaned) as T } catch { /* continue */ }

    cleaned = repairTruncatedJson(cleaned)
    try { return JSON.parse(cleaned) as T } catch { /* continue */ }

    // 候选片段也尝试 lenient 兜底
    const lenient = lenientJsonRecovery<T>(cleaned)
    if (lenient !== undefined) return lenient
  }

  return undefined
}

// ===== 终极兜底：Lenient JSON 解析器 =====

/**
 * 基于逐字符 token 扫描的容错 JSON 解析器
 *
 * 当前面所有修复策略都失败时，此解析器会直接在原始文本中扫描，
 * 提取出可识别的 key-value 对并重建合法 JSON。
 *
 * 支持：
 * - 对象：{"key": "value"} 和 {key: value}
 * - 数组：[{...}, {...}]
 * - 嵌套结构：对象中包含对象/数组
 * - 缺失逗号、多余逗号
 * - 未加引号的 key 和字符串值
 * - 截断的 JSON
 * - 混合引号（单/双）
 */
function lenientJsonRecovery<T>(text: string): T | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined

  try {
    const parser = new LenientParser(trimmed)
    const result = parser.parse()
    if (result !== undefined && result !== null) {
      return result as T
    }
  } catch {
    // 解析器内部异常，返回 undefined
  }

  // 最后尝试：正则提取数组内多个对象
  return extractArrayObjects<T>(trimmed)
}

/**
 * Lenient JSON 逐字符解析器
 *
 * 核心思路：模拟 JSON 解析器的状态机，但对每个语法点都容错处理
 */
class LenientParser {
  private pos = 0
  private text: string

  constructor(text: string) {
    this.text = text
  }

  parse(): unknown {
    this.skipWhitespace()
    if (this.pos >= this.text.length) return undefined

    const ch = this.text[this.pos]
    if (ch === '{') return this.parseObject()
    if (ch === '[') return this.parseArray()
    return undefined
  }

  // ---------- 对象解析 ----------

  private parseObject(): Record<string, unknown> {
    const obj: Record<string, unknown> = {}
    this.expect('{') // 消费 '{'

    while (this.pos < this.text.length) {
      this.skipWhitespaceAndCommas()

      // 结束检查
      if (this.pos >= this.text.length) break
      if (this.text[this.pos] === '}') {
        this.pos++ // 消费 '}'
        return obj
      }

      // 解析 key
      const key = this.parseKey()
      if (key === null) {
        // 无法解析 key，尝试跳过直到下一个可识别的 key 或结束
        if (!this.skipToNextKey()) break
        continue
      }

      // 期望 ':'（容错：允许 '='、'->'' 或缺失）
      this.skipWhitespace()
      if (this.pos < this.text.length) {
        const ch = this.text[this.pos]
        if (ch === ':' || ch === '=') {
          this.pos++
          // 允许 :: 或 =>
          if (this.pos < this.text.length && (this.text[this.pos] === ':' || this.text[this.pos] === '>')) {
            this.pos++
          }
        }
      }

      // 解析 value
      this.skipWhitespace()
      const value = this.parseValue()
      obj[key] = value

      // 期望 ',' 或 '}'（容错：可省略逗号）
      this.skipWhitespace()
      if (this.pos < this.text.length && this.text[this.pos] === ',') {
        this.pos++
      }
      // 不强制要求逗号，继续循环即可
    }

    return obj
  }

  // ---------- 数组解析 ----------

  private parseArray(): unknown[] {
    const arr: unknown[] = []
    this.expect('[') // 消费 '['

    while (this.pos < this.text.length) {
      this.skipWhitespaceAndCommas()

      if (this.pos >= this.text.length) break
      if (this.text[this.pos] === ']') {
        this.pos++ // 消费 ']'
        return arr
      }

      const value = this.parseValue()
      if (value !== undefined) {
        arr.push(value)
      }

      // 期望 ',' 或 ']'（容错）
      this.skipWhitespace()
      if (this.pos < this.text.length && this.text[this.pos] === ',') {
        this.pos++
      }
    }

    return arr
  }

  // ---------- Key 解析 ----------

  private parseKey(): string | null {
    this.skipWhitespace()
    if (this.pos >= this.text.length) return null

    const ch = this.text[this.pos]

    // 引号包裹的 key
    if (ch === '"' || ch === "'") {
      return this.parseQuotedString()
    }

    // 未加引号的 key（标识符）
    if (this.isIdentStart(ch)) {
      return this.parseIdentifier()
    }

    return null
  }

  // ---------- Value 解析 ----------

  private parseValue(): unknown {
    this.skipWhitespace()
    if (this.pos >= this.text.length) return null

    const ch = this.text[this.pos]

    // 嵌套对象
    if (ch === '{') return this.parseObject()
    // 嵌套数组
    if (ch === '[') return this.parseArray()
    // 引号字符串
    if (ch === '"' || ch === "'") return this.parseQuotedString()
    // 字面量
    if (this.lookAhead('true')) { this.pos += 4; return true }
    if (this.lookAhead('false')) { this.pos += 5; return false }
    if (this.lookAhead('null') || this.lookAhead('None')) { this.pos += 4; return null }
    if (this.lookAhead('undefined')) { this.pos += 9; return null }
    // 数字
    if (this.isDigitOrMinus(ch)) return this.parseNumber()
    // 裸字符串（无引号的字符串值，直到遇到逗号、}、] 或换行）
    return this.parseBareValue()
  }

  // ---------- 字符串解析 ----------

  private parseQuotedString(): string {
    const quote = this.text[this.pos]
    this.pos++ // 消费开始引号
    let result = ''

    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]

      // 转义序列
      if (ch === '\\') {
        this.pos++
        if (this.pos >= this.text.length) break
        const esc = this.text[this.pos]
        switch (esc) {
          case 'n': result += '\n'; break
          case 'r': result += '\r'; break
          case 't': result += '\t'; break
          case '\\': result += '\\'; break
          case '/': result += '/'; break
          case '"': result += '"'; break
          case "'": result += "'"; break
          case 'u': {
            // \uXXXX
            const hex = this.text.substring(this.pos + 1, this.pos + 5)
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              result += String.fromCharCode(parseInt(hex, 16))
              this.pos += 4
            } else {
              result += 'u'
            }
            break
          }
          default:
            // 未知转义，原样保留
            result += '\\' + esc
        }
        this.pos++
        continue
      }

      // 匹配结束引号（同时接受另一种引号作为结束，提高容错性）
      if (ch === quote) {
        this.pos++ // 消费结束引号
        return result
      }

      // 容错：如果开始是单引号但遇到了双引号且后面紧跟冒号/逗号/括号，
      // 说明单引号字符串已结束（LLM 混用引号）
      if (quote === "'" && ch === '"') {
        // 检查是否看起来像新的 key 开始
        const nextNonSpace = this.peekNonWhitespace(this.pos + 1)
        if (nextNonSpace === ':' || nextNonSpace === ',' || nextNonSpace === '}' || nextNonSpace === ']') {
          // 结束当前单引号字符串，回退让外层处理双引号
          return result
        }
      }

      // 容错：未转义的真实换行（LLM 常在字符串内换行）
      if (ch === '\n' || ch === '\r') {
        result += '\n'
        this.pos++
        continue
      }

      result += ch
      this.pos++
    }

    // 字符串未闭合，返回已收集的内容
    return result
  }

  // ---------- 数字解析 ----------

  private parseNumber(): number | null {
    const start = this.pos
    if (this.text[this.pos] === '-') this.pos++

    // 整数部分
    while (this.pos < this.text.length && /\d/.test(this.text[this.pos])) this.pos++

    // 小数部分
    if (this.pos < this.text.length && this.text[this.pos] === '.') {
      this.pos++
      while (this.pos < this.text.length && /\d/.test(this.text[this.pos])) this.pos++
    }

    // 指数部分
    if (this.pos < this.text.length && (this.text[this.pos] === 'e' || this.text[this.pos] === 'E')) {
      this.pos++
      if (this.pos < this.text.length && (this.text[this.pos] === '+' || this.text[this.pos] === '-')) this.pos++
      while (this.pos < this.text.length && /\d/.test(this.text[this.pos])) this.pos++
    }

    const numStr = this.text.substring(start, this.pos)
    const num = Number(numStr)
    return isNaN(num) ? null : num
  }

  // ---------- 裸值解析（无引号的值） ----------

  private parseBareValue(): string {
    let result = ''
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]
      // 终止符：JSON 结构分隔符或换行
      if (ch === ',' || ch === '}' || ch === ']' || ch === '\n' || ch === '\r') break
      // 如果后面紧跟 ':' 说明这是下一个 key，停止
      if (ch === ':') break
      result += ch
      this.pos++
    }
    return result.trim()
  }

  // ---------- 标识符解析 ----------

  private parseIdentifier(): string {
    const start = this.pos
    while (this.pos < this.text.length && this.isIdentPart(this.text[this.pos])) {
      this.pos++
    }
    return this.text.substring(start, this.pos)
  }

  // ---------- 辅助方法 ----------

  private skipWhitespace(): void {
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) {
      this.pos++
    }
    // 跳过行内注释
    if (this.pos + 1 < this.text.length && this.text[this.pos] === '/' && this.text[this.pos + 1] === '/') {
      while (this.pos < this.text.length && this.text[this.pos] !== '\n') this.pos++
      this.skipWhitespace()
    }
  }

  private skipWhitespaceAndCommas(): void {
    this.skipWhitespace()
    while (this.pos < this.text.length && this.text[this.pos] === ',') {
      this.pos++
      this.skipWhitespace()
    }
  }

  private expect(ch: string): void {
    if (this.pos < this.text.length && this.text[this.pos] === ch) {
      this.pos++
    }
  }

  private lookAhead(str: string): boolean {
    return this.text.substring(this.pos, this.pos + str.length) === str
  }

  private peekNonWhitespace(from: number): string {
    let i = from
    while (i < this.text.length && /\s/.test(this.text[i])) i++
    return i < this.text.length ? this.text[i] : ''
  }

  private isIdentStart(ch: string): boolean {
    return /[a-zA-Z_$\u4e00-\u9fff]/.test(ch) // 支持中文 key
  }

  private isIdentPart(ch: string): boolean {
    return /[a-zA-Z0-9_$\u4e00-\u9fff\-.]/.test(ch) // 支持中文、连字符
  }

  private isDigitOrMinus(ch: string): boolean {
    return /[\d-]/.test(ch)
  }

  /**
   * 当 key 解析失败时，尝试跳过垃圾字符直到找到下一个可能的 key
   * 返回 true 表示找到了可能的 key 位置，false 表示已到达结尾
   */
  private skipToNextKey(): boolean {
    while (this.pos < this.text.length) {
      const ch = this.text[this.pos]
      // 遇到引号或标识符开头，可能是下一个 key
      if (ch === '"' || ch === "'" || this.isIdentStart(ch)) return true
      // 遇到对象结束，让外层处理
      if (ch === '}') return false
      this.pos++
    }
    return false
  }
}

/**
 * 从数组格式的文本中提取对象列表
 * 处理场景：[{...}, {...}, ...] 中部分对象格式错误
 * 策略：找到每个 {...} 边界，逐个 lenient 解析
 */
function extractArrayObjects<T>(text: string): T | undefined {
  // 查找所有顶层 {...} 片段
  const objects: Record<string, unknown>[] = []
  let i = 0

  while (i < text.length) {
    if (text[i] === '{') {
      // 找到匹配的 '}'（简单的括号计数，容错字符串内括号）
      let depth = 0
      let inStr = false
      let esc = false
      const start = i

      for (let j = i; j < text.length; j++) {
        const ch = text[j]
        if (esc) { esc = false; continue }
        if (ch === '\\' && inStr) { esc = true; continue }
        if (ch === '"' || ch === "'") { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{') depth++
        if (ch === '}') {
          depth--
          if (depth === 0) {
            const fragment = text.substring(start, j + 1)
            // 用 LenientParser 解析单个对象
            try {
              const parser = new LenientParser(fragment)
              const obj = parser.parse()
              if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                objects.push(obj as Record<string, unknown>)
              }
            } catch { /* 跳过无法解析的片段 */ }
            i = j + 1
            break
          }
        }
      }

      // 如果没有找到匹配的 '}'，用整个剩余文本尝试
      if (depth > 0) {
        const fragment = text.substring(start)
        try {
          const parser = new LenientParser(fragment)
          const obj = parser.parse()
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            objects.push(obj as Record<string, unknown>)
          }
        } catch { /* 忽略 */ }
        break
      }
    } else {
      i++
    }
  }

  if (objects.length > 0) {
    return objects as unknown as T
  }
  return undefined
}

// ===== 通用重试包装器 =====

/**
 * 带重试的异步操作包装器
 * @param fn 要执行的异步函数
 * @param maxRetries 最大重试次数（不含首次执行）
 * @param label 操作标签（用于日志）
 * @param callbacks 步骤回调（用于输出日志）
 * @returns 成功返回 { ok: true }，全部失败返回 { ok: false, error }
 */
export async function withRetry(
  fn: () => Promise<void>,
  maxRetries: number,
  label: string,
  callbacks: StepCallbacks,
): Promise<{ ok: boolean; error?: string; attempts: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await fn()
      return { ok: true, attempts: attempt + 1 }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      if (attempt < maxRetries) {
        callbacks.log(`  ⚠️ ${label} 第${attempt + 1}次失败，正在重试...（${errMsg}）`)
      } else {
        return { ok: false, error: errMsg, attempts: attempt + 1 }
      }
    }
  }
  return { ok: false, error: '未知错误', attempts: maxRetries + 1 }
}

// ===== 后处理流水线 =====

/** 单个后处理步骤定义 */
export interface PostProcessStep {
  /** 唯一标识，如 'chapter_notes' */
  key: string
  /** 展示名称，如 '📋 章节要点' */
  label: string
  /** 关键步骤（失败阻断下游工作流） */
  critical: boolean
  /** 步骤执行器 */
  executor: (callbacks: StepCallbacks) => Promise<void>
}

/** 单步后处理执行结果（持久化到状态文件） */
export interface PostProcessStepResult {
  label: string
  critical: boolean
  ok: boolean
  completedAt?: string
  error?: string
  lastAttemptAt: string
  attemptCount: number
}

/** 后处理状态（持久化到 .vela/post_process/{scope}.json） */
export interface PostProcessStatus {
  /** 唯一标识，如 'chapter_1_finalize' */
  scope: string
  /** 来源描述，如 '第1章定稿' */
  sourceLabel: string
  /** 首次执行时间 */
  createdAt: string
  /** 最后更新时间 */
  updatedAt: string
  /** 各步骤执行结果 */
  steps: Record<string, PostProcessStepResult>
  /** 所有关键步骤是否通过 */
  allCriticalPassed: boolean
}

/** 解析原有 scope 字符串为 sourceType 和 sourceId */
function parseScope(scope: string): { sourceType: string; sourceId: string } {
  const match = scope.match(/^chapter_(\d+)_finalize$/)
  if (match) return { sourceType: 'chapter_finalize', sourceId: match[1] }
  return { sourceType: 'unknown', sourceId: scope }
}

/** 读取后处理状态 (向后兼容 UI) */
export async function readPostProcessStatus(
  _projectPath: string,
  scope: string,
): Promise<PostProcessStatus | null> {
  try {
    const { sourceType, sourceId } = parseScope(scope)
    const run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
    if (!run) return null

    const steps = await ipc.invoke('db:post-process-get-steps', run.id)

    const status: PostProcessStatus = {
      scope,
      sourceLabel: run.sourceLabel,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      allCriticalPassed: run.allCriticalPassed,
      steps: {}
    }

    for (const s of steps) {
      status.steps[s.stepKey] = {
        label: s.label,
        critical: s.critical,
        ok: s.ok,
        completedAt: s.completedAt || undefined,
        error: s.errorMsg || undefined,
        lastAttemptAt: s.lastAttemptAt || '',
        attemptCount: s.attemptCount
      }
    }

    return status
  } catch {
    return null
  }
}

/** 快捷检查：所有关键步骤是否通过 */
export async function isAllCriticalPassed(
  _projectPath: string,
  scope: string,
): Promise<boolean> {
  const { sourceType, sourceId } = parseScope(scope)
  return await ipc.invoke('db:post-process-is-all-passed', sourceType, sourceId)
}

/** 提取失败步骤的展示标签列表 */
export function getFailedStepLabels(status: PostProcessStatus): string[] {
  return Object.values(status.steps)
    .filter(s => !s.ok)
    .map(s => s.label)
}

/** 获取章节定稿后处理的 scope 标识 */
export function getChapterFinalizeScope(chapterNumber: number): string {
  return `chapter_${chapterNumber}_finalize`
}

// ===== 流水线执行器 =====

export interface PipelineOptions {
  /** 每步重试次数，默认 2 */
  retryCount?: number
  /** true = 只重跑失败步骤（修复模式） */
  onlyFailed?: boolean
}

/**
 * 执行后处理流水线
 *
 * @param projectPath 项目路径（用于状态文件读写）
 * @param scope 状态文件唯一标识
 * @param sourceLabel 来源描述（展示用）
 * @param steps 步骤列表
 * @param callbacks 工作流回调
 * @param options 可选配置
 * @returns 完整的后处理状态
 */
export async function runPostProcessPipeline(
  projectPath: string,
  scope: string,
  sourceLabel: string,
  steps: PostProcessStep[],
  callbacks: StepCallbacks,
  options?: PipelineOptions,
): Promise<PostProcessStatus> {
  const retryCount = options?.retryCount ?? 2
  const onlyFailed = options?.onlyFailed ?? false

  const { sourceType, sourceId } = parseScope(scope)

  // 判断是否存在已有 instance
  let run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)

  if (!onlyFailed || !run) {
    // 新建跑批
    callbacks.log(`  初始化后处理跑批...`)
    const createRes = await ipc.invoke('db:post-process-create-run', {
      triggerSourceType: sourceType,
      triggerSourceId: sourceId,
      sourceLabel,
      steps: steps.map(s => ({ key: s.key, label: s.label, critical: s.critical }))
    })
    if (!createRes.success || !createRes.id) {
      throw new Error(`创建跑批失败: ${createRes.error}`)
    }
    run = await ipc.invoke('db:post-process-get-latest-run', sourceType, sourceId)
  }

  if (!run) throw new Error('跑批获取异常')

  const runId = run.id
  const runSteps = await ipc.invoke('db:post-process-get-steps', runId)
  const stepMap = new Map((runSteps as unknown as Array<Record<string, unknown>>).map((s) => [s.stepKey, s]))

  for (const step of steps) {
    const existingStep = stepMap.get(step.key)

    // 修复模式：跳过已成功的步骤
    if (onlyFailed && existingStep?.ok) {
      callbacks.log(`  ⏭️ ${step.label} — 已成功，跳过`)
      continue
    }

    const result = await withRetry(() => step.executor(callbacks), retryCount, step.label, callbacks)

    if (result.ok) {
      await ipc.invoke('db:post-process-mark-step-ok', runId, step.key)
    } else {
      await ipc.invoke('db:post-process-mark-step-failed', runId, step.key, result.error || '未知错误')
    }
  }

  // 返回最终状态汇总供 UI 展示
  const status = await readPostProcessStatus(projectPath, scope)
  if (!status) {
    throw new Error('汇总状态获取失败')
  }

  // 最终汇总
  const failedSteps = Object.values(status.steps).filter(s => !s.ok)
  const successSteps = Object.values(status.steps).filter(s => s.ok)

  callbacks.log('')
  callbacks.log(`━━━━━━━━━━ ${sourceLabel} 后处理汇总 ━━━━━━━━━━`)
  for (const [, r] of Object.entries(status.steps)) {
    callbacks.log(`  ${r.ok ? '✅' : '❌'} ${r.label}${r.ok ? '' : ` — ${r.error}`}`)
  }
  callbacks.log(`━━━━━━━━━━ ${successSteps.length}/${Object.keys(status.steps).length} 成功 ━━━━━━━━━━`)

  if (failedSteps.length > 0) {
    const failedLabels = failedSteps.map(r => r.label).join('、')
    callbacks.log(`⚠️ 以下后处理步骤失败：${failedLabels}`)
    if (failedSteps.some(s => s.critical)) {
      callbacks.log('💡 存在关键步骤失败，后续流程可能被阻断。请在对应页面使用「重试」功能修复')
    }
  }

  return status
}
