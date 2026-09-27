/**
 * 复制敏感值到剪贴板并在超时后主动覆写。
 *
 * 密码本复制的往往是账号密码 / Token，复制完长期留在系统剪贴板里，
 * 之后任何应用（以及用户自己误粘贴）都能拿到。这里在 CLIPBOARD_TTL_MS
 * 后写入一段占位文本把内容顶掉。
 *
 * 注意：浏览器/Electron 都禁止在无用户手势时读写剪贴板，所以必须由 click 直接触发。
 */
export const CLIPBOARD_TTL_MS = 45000
const CLIPBOARD_PLACEHOLDER = ''

/**
 * @param {string} text 要复制的内容
 * @param {number} ttl 自动清理延时（毫秒）
 * @returns {Promise<boolean>} 是否复制成功
 */
export async function copyWithAutoClear (text, ttl = CLIPBOARD_TTL_MS) {
  const value = String(text ?? '')
  let ok = false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      ok = true
    } else {
      ok = legacyCopy(value)
    }
  } catch (err) {
    ok = legacyCopy(value)
  }
  if (!ok) return false

  setTimeout(() => {
    // 只在剪贴板内容仍是刚复制的那段时才清理，避免把用户之后复制的内容抹掉
    navigator.clipboard?.readText?.()
      .then(current => {
        if (current === value) {
          return navigator.clipboard.writeText(CLIPBOARD_PLACEHOLDER)
        }
      })
      .catch(() => { /* 读权限被拒时跳过清理 */ })
  }, ttl)

  return true
}

function legacyCopy (value) {
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch (err) {
    return false
  }
}
