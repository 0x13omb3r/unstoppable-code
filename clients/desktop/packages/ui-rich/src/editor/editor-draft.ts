import {
  Editor,
  Element as SlateElement,
  Node as SlateNode,
  Transforms,
  type BaseRange,
  type Point,
} from 'slate';
import { HistoryEditor } from 'slate-history';
import type { ChatEditor } from '../types';
import {
  buildEditorValueFromMessage,
  serializeEditorValue,
} from './slate-utils';

/**
 * Offsets here count the draft as `serializeEditorValue` writes it: lines
 * joined by `\n`, a file-reference pill as its display path.
 */
function childLength(child: SlateNode): number {
  if (SlateElement.isElement(child)) {
    return child.type === 'file-reference' ? child.displayPath.length : 0;
  }
  return SlateNode.string(child).length;
}

/** The serialized offset of `point`, which lies in a line's text child. */
function offsetOf(editor: ChatEditor, point: Point): number {
  const [line = 0, index = 0] = point.path;
  let offset = 0;
  for (let at = 0; at < line; at += 1) {
    const block = editor.children[at];
    offset +=
      block === undefined ? 0 : serializeEditorValue([block]).text.length;
    offset += 1;
  }
  const block = editor.children[line];
  const children =
    block !== undefined && SlateElement.isElement(block) ? block.children : [];
  for (let at = 0; at < index && at < children.length; at += 1) {
    offset += childLength(children[at]);
  }
  return offset + point.offset;
}

/** The point at serialized `offset`; inside a pill, the point just after it. */
function pointAt(editor: ChatEditor, offset: number): Point {
  let left = offset;
  for (const [line, block] of editor.children.entries()) {
    if (!SlateElement.isElement(block)) continue;
    const length = serializeEditorValue([block]).text.length;
    if (left > length) {
      left -= length + 1;
      continue;
    }
    for (const [index, child] of block.children.entries()) {
      const size = childLength(child);
      if (!SlateElement.isElement(child) && left <= size) {
        return { path: [line, index], offset: left };
      }
      left = Math.max(0, left - size);
    }
    return Editor.end(editor, [line]);
  }
  return Editor.end(editor, []);
}

/** The composer's whole draft and its caret, as the draft would send. */
export function readEditorDraft(editor: ChatEditor): {
  readonly text: string;
  readonly cursor: number;
} {
  const { text } = serializeEditorValue(editor.children);
  const caret = editor.selection?.focus;
  const cursor = caret === undefined ? text.length : offsetOf(editor, caret);
  return { text, cursor: Math.min(Math.max(cursor, 0), text.length) };
}

/**
 * Places `text` in the draft as one undoable change: over the whole draft
 * (`replace`), after it (`append`), or at the caret (`insert`). The caret
 * ends after the placed text, or at serialized offset `cursor` when given.
 */
export function fillEditorDraft(
  editor: ChatEditor,
  text: string,
  mode: 'replace' | 'append' | 'insert',
  cursor?: number,
): void {
  // Its own history batch, so one undo takes back the fill and nothing the
  // person did before it.
  HistoryEditor.withNewBatch(editor, () => {
    const whole: BaseRange = {
      anchor: Editor.start(editor, []),
      focus: Editor.end(editor, []),
    };
    if (mode === 'replace') {
      Transforms.delete(editor, { at: whole });
      Transforms.select(editor, Editor.start(editor, []));
    } else if (mode === 'append' || editor.selection === null) {
      Transforms.select(editor, Editor.end(editor, []));
    }
    if (text !== '') {
      Transforms.insertFragment(editor, buildEditorValueFromMessage(text, []));
    }
  });
  if (cursor !== undefined) Transforms.select(editor, pointAt(editor, cursor));
}
