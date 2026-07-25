import { EditorView, Decoration } from '@codemirror/view'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'

export const setSpellCheckConfig = StateEffect.define()

export function spellCheckExtension(getSpellErrors, spellEnabled, getSpellVersion) {
  const spellField = StateField.define({
    create(state) {
      return buildDecorations(state.doc.toString(), getSpellErrors, getSpellVersion)
    },
    update(decorations, tr) {
      if (tr.docChanged || tr.effects.some(e => e.is(setSpellCheckConfig))) {
        return buildDecorations(tr.state.doc.toString(), getSpellErrors, getSpellVersion)
      }
      return decorations
    },
    provide: (f) => EditorView.decorations.from(f)
  })

  return [
    spellField,
    EditorView.theme({
      '.cm-spell-error': {
        textDecoration: 'wavy underline var(--state-error)',
        textDecorationThickness: '1.5px',
        textUnderlineOffset: '2px',
        cursor: 'pointer'
      }
    })
  ]
}

function buildDecorations(text, getSpellErrors, getSpellVersion) {
  getSpellVersion?.()
  
  const errors = getSpellErrors(text) || []
  const builder = new RangeSetBuilder()
  
  const sortedErrors = [...errors].sort((a, b) => a.start - b.start)
  
  let lastEnd = 0
  for (const error of sortedErrors) {
    if (error.start < lastEnd) continue
    if (error.start >= error.end) continue
    
    builder.add(
      error.start,
      error.end,
      Decoration.mark({ class: 'cm-spell-error' })
    )
    lastEnd = error.end
  }
  
  return builder.finish()
}

export function forceSpellUpdate(view) {
  view.dispatch({
    effects: setSpellCheckConfig.of(true)
  })
}
