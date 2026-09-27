/**
 * 转发文件。
 *
 * livePreview.js 已按职责拆成 src/utils/editor/livePreview/ 目录
 * （constants / scan / inline / highlight / widgets / blocks / index）。
 *
 * 这里保留同名文件的原因：既有引用里有写成显式扩展名的形式 ——
 * `tests/livePreview.test.js` 的 `from '../src/utils/editor/livePreview.js'`
 * 与 `src/composables/useEditor.js` 的 `from '../utils/editor/livePreview'`。
 * 前者按文件名精确解析，不会退化成目录 index，删掉就 404。
 * 因此保留一层纯转发，保证对外接口与拆分前逐字一致。
 */
export * from './livePreview/index.js'
