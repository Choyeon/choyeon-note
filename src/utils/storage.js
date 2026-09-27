/**
 * localStorage 安全封装。
 *
 * localStorage 在三种情况下会抛：隐私模式（Safari/部分 Chromium 配置直接禁用）、
 * 配额写满（QuotaExceededError）、跨源 iframe 中被策略拦截。之前 vault.js 与
 * workspace.js 各写一份 try/catch 的 readLocal，行为一致但分散，新增调用点容易
 * 忘记包 try —— 一次抛错会打断整个 hydrate 流程。
 *
 * 约定：写入失败只影响持久化，不影响内存态，因此一律静默降级。
 */

/** 读取并 JSON 解析；键不存在 / 解析失败 / 存储不可用时返回 fallback */
export function readLocal (key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** JSON 序列化后写入；配额不足或存储被禁用时忽略（内存态仍然可用） */
export function writeLocal (key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* 忽略：配额不足 / 隐私模式 */
  }
}

/** 删除键；存储不可用时不抛 */
export function removeLocal (key) {
  try {
    localStorage.removeItem(key)
  } catch {
    /* 忽略：存储不可用 */
  }
}
