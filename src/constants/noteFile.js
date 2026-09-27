/**
 * 笔记文件扩展名白名单（渲染侧唯一来源）。
 *
 * 载入时三种后缀都认，切换默认扩展名不会让旧笔记"消失"；新建时才按设置项
 * 决定具体用哪一种（见 note.js 的 newNoteExtension）。
 *
 * 注意：electron/main.cjs 里有一份同名白名单，那是**主进程的安全边界**，
 * 必须保持独立 —— 渲染进程被攻破时不能靠它自己的常量来约束文件读写。
 */

/** 允许的扩展名，不带点 */
export const NOTE_EXTENSIONS = ['md', 'markdown', 'txt']

/** 匹配笔记文件后缀（大小写不敏感） */
export const EXT_PATTERN = /\.(md|markdown|txt)$/i
