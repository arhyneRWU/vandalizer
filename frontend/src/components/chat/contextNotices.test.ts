import { describe, it, expect } from 'vitest'
import { contextNoticeHeading } from './contextNotices'

// ---------------------------------------------------------------------------
// The banner above a chat answer explains what the server had to do to make the
// request fit. Every action except `documents_*` used to fall through to
// "Context was compacted" — which became untrue the moment routing was added.
//
// Routing exists precisely so the document is NOT compacted: a request too big
// for the chosen model is answered by a bigger one with the whole document in
// view. Announcing that as compaction tells the user the opposite of what
// happened, and does it in warning styling on a success.
// ---------------------------------------------------------------------------

const notice = (action: string) => ({ action, detail: 'irrelevant to the heading' })

describe('contextNoticeHeading', () => {
  it('names document problems when the notice is about documents', () => {
    expect(contextNoticeHeading([notice('documents_skipped')]).heading).toBe(
      'About your selected documents:',
    )
  })

  it('says content was dropped when it actually was', () => {
    expect(contextNoticeHeading([notice('history_trimmed')]).heading).toBe(
      'Context was compacted to fit the model:',
    )
  })

  it('does not claim compaction when the request was routed to a bigger model', () => {
    // The whole point of routing is that nothing was thrown away.
    expect(contextNoticeHeading([notice('model_routed')]).heading).not.toMatch(/compact/i)
  })

  it('says a different model answered when the request was routed', () => {
    expect(contextNoticeHeading([notice('model_routed')]).heading).toBe(
      'Answered with a different model to fit your document:',
    )
  })

  it('treats a successful route as information, not a warning', () => {
    expect(contextNoticeHeading([notice('model_routed')]).tone).toBe('info')
  })

  it('warns when content was compacted', () => {
    expect(contextNoticeHeading([notice('documents_trimmed')]).tone).toBe('warning')
  })

  it('still warns when routing declined and the document was trimmed anyway', () => {
    // `model_not_routed` means no model could hold it — compaction followed.
    const r = contextNoticeHeading([notice('model_not_routed')])
    expect(r.heading).toBe('Context was compacted to fit the model:')
    expect(r.tone).toBe('warning')
  })

  it('lets a document problem outrank a routing notice', () => {
    // Pre-existing precedence: a skipped document is the more actionable fact.
    expect(
      contextNoticeHeading([notice('model_routed'), notice('documents_skipped')]).heading,
    ).toBe('About your selected documents:')
  })
})
