const path = require('path')
const fs = require('fs/promises')

/**
 * 判断 target 是否位于 base 之内（纯字符串边界检查）。
 * 用 path.relative 而不是 startsWith，避免 /notes_evil 这类前缀绕过。
 * @param {string} base 已规范化的基目录
 * @param {string} target 已规范化的目标路径
 * @returns {boolean}
 */
function isInside(base, target) {
  const rel = path.relative(base, target)
  if (rel === '') return true
  // Windows 下盘符不同时 relative 会返回绝对路径
  if (path.isAbsolute(rel)) return false
  if (rel === '..' || rel.startsWith('..' + path.sep)) return false
  return true
}

/**
 * 校验目标路径是否位于 notesPath 目录内，防止路径穿越。
 *
 * 注意：这是**纯字符串**检查，不解析符号链接。仅适用于性能敏感且调用方能保证
 * 目录内无用户自建 symlink 的场景。涉及真实文件读写的 IPC 请一律使用
 * {@link validatePathAsync}。
 *
 * @param {string} notesPath 允许访问的根目录
 * @param {string} targetPath 待校验的目标路径
 * @returns {string} 规范化后的安全路径
 */
function validatePath(notesPath, targetPath) {
  if (!notesPath) {
    throw new Error('Notes path not set')
  }
  if (typeof targetPath !== 'string' || targetPath.length === 0) {
    throw new Error('Invalid path')
  }
  const normalizedTarget = path.normalize(path.resolve(targetPath))
  const normalizedBase = path.normalize(path.resolve(notesPath))
  if (!isInside(normalizedBase, normalizedTarget)) {
    throw new Error('Access denied: path outside notes directory')
  }
  return normalizedTarget
}

/**
 * 将若干路径片段 join 后校验其安全性。
 * @param {string} notesPath 允许访问的根目录
 * @param {string[]} parts 待拼接的路径片段
 * @returns {string} 规范化后的安全路径
 */
function safeJoin(notesPath, ...parts) {
  return validatePath(notesPath, path.join(...parts))
}

/**
 * 解析真实路径。目标不存在（例如即将新建的文件）时，退化为解析其父目录
 * 再拼回文件名——这样新文件的父亲若是笔记库外的符号链接，依然会被拦下。
 * @param {string} p
 * @returns {Promise<string|null>} 解析失败返回 null（视为非法）
 */
async function realpathOrParent(p) {
  try {
    return await fs.realpath(p)
  } catch (err) {
    const parent = path.dirname(p)
    if (parent === p) return null
    try {
      const realParent = await fs.realpath(parent)
      return path.join(realParent, path.basename(p))
    } catch (err2) {
      return null
    }
  }
}

/**
 * 带符号链接解析的异步路径校验——所有真实文件读写 IPC 都必须走这里。
 *
 * 为什么必须 realpath：笔记库里出现 symlink 是常态（用户自己建的、同步盘建的）。
 * 若只做字符串边界检查，`notes/links -> /etc` 之后读 `notes/links/shadow`
 * 能通过校验并越权读取。这里对 base 与 target 都解析真实路径再比对。
 *
 * @param {string} notesPath 允许访问的根目录
 * @param {string} targetPath 待校验的目标路径
 * @returns {Promise<string>} 真实路径（已解析 symlink）
 * @throws {Error} 越界、路径不存在父目录、或解析失败
 */
async function validatePathAsync(notesPath, targetPath) {
  const preChecked = validatePath(notesPath, targetPath)

  const realBase = await realpathOrParent(path.resolve(notesPath))
  if (!realBase) {
    throw new Error('Access denied: notes directory is not accessible')
  }
  // 目标还不存在时 realpathOrParent 会退化到父目录，父目录必须真实存在
  const realTarget = await realpathOrParent(preChecked)
  if (!realTarget) {
    throw new Error('Access denied: parent directory does not exist')
  }
  if (!isInside(realBase, realTarget)) {
    throw new Error('Access denied: path resolves outside notes directory')
  }
  return realTarget
}

module.exports = { validatePath, safeJoin, validatePathAsync, isInside }
