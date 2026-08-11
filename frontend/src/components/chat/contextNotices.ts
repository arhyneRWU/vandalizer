/**
 * How to announce what the server did to make a request fit.
 *
 * Every action but `documents_*` used to fall through to "Context was
 * compacted", which stopped being true when routing was added: routing exists
 * so the document is *not* compacted — a request too big for the chosen model
 * is answered by a bigger one with the whole document in view. Announcing that
 * as compaction tells the user the opposite of what happened, in warning
 * styling, on a success.
 */

export type ContextNoticeLike = { action: string }

export type NoticeHeading = {
  heading: string
  tone: 'info' | 'warning'
}

export function contextNoticeHeading(notices: ContextNoticeLike[]): NoticeHeading {
  // A skipped or unreadable document is the more actionable fact, so it keeps
  // precedence over anything else in the same batch.
  if (notices.some((n) => n.action.startsWith('documents_'))) {
    return { heading: 'About your selected documents:', tone: 'warning' }
  }
  // Only a *successful* switch avoided losing content. `model_not_routed`
  // means nothing could hold the request, so it was trimmed after all.
  if (notices.some((n) => n.action === 'model_routed')) {
    return {
      heading: 'Answered with a different model to fit your document:',
      tone: 'info',
    }
  }
  return { heading: 'Context was compacted to fit the model:', tone: 'warning' }
}
