import { reactive, ref } from 'vue'

/**
 * Sidebar ↔ FolderNode 共享的 provide/inject key。
 * 如果 dndCtxKey 是在 FolderNode 内部定义的 Symbol，Sidebar 无法用相同 key 注入，
 * FolderNode 会退回使用空 stub 导致 move/createNote/onRenameComplete 全部空转。
 * 所以抽成独立模块让双方拿到同一 Symbol。
 */
export const dndCtxKey = Symbol('folderNodeDndCtx')

export function createDndCtx() {
  return {
    dropState: reactive({ kind: '', path: '', parentPath: '' }),
    dragPayload: reactive({ type: '', id: '', sourceFolder: '' }),
    editing: reactive({ active: false, type: '', target: '', value: '' }),
    renameInputRef: ref(null),
    onRenameComplete: (_payload) => {},
    request: {
      move: (_p) => {},
      contextMenu: (_p) => {},
      createNote: (_p) => {},
      createFolder: (_p) => {},
      deleteItem: (_p) => {},
      toggleFolder: (_p) => {},
      selectFolder: (_p) => {}
    }
  }
}
