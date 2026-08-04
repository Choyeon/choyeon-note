const path = require('path')

/**
 * 校验目标路径是否位于 notesPath 目录内，防止路径穿越。
 * 使用 path.relative 做边界检查，避免 startsWith 的前缀绕过（如 /notes_evil）。
 * @param {string} notesPath 允许访问的根目录
 * @param {string} targetPath 待校验的目标路径
 * @returns {string} 规范化后的安全路径
 */
function validatePath(notesPath, targetPath) {
  if (!notesPath) {
    throw new Error('Notes path not set')
  }
  const normalizedTarget = path.normalize(targetPath)
  const normalizedBase = path.normalize(notesPath)
  const rel = path.relative(normalizedBase, normalizedTarget)
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
    return normalizedTarget
  }
  throw new Error('Access denied: path outside notes directory')
}

/**
 * 将若干路径片段 join 后校验其安全性。
 * @param {string} notesPath 允许访问的根目录
 * @param {string[]} parts 待拼接的路径片段
 * @returns {string} 规范化后的安全路径
 */
function safeJoin(notesPath, ...parts) {
  const joined = path.join(...parts)
  return validatePath(notesPath, joined)
}

module.exports = { validatePath, safeJoin }