export interface SupportMessage {
  uuid: string
  user_id: string
  user_name: string | null
  content: string
  is_support_reply: boolean
  // Internal notes are visible only to support agents. The backend strips
  // these from the messages array for everyone else, so non-agent callers
  // will never receive a message with this set to true.
  is_internal_note: boolean
  created_at: string | null
  edited_at: string | null
}

export interface SupportAttachment {
  uuid: string
  filename: string
  file_type: string | null
  uploaded_by: string
  message_uuid: string | null
  created_at: string | null
}

export interface SupportWatcher {
  user_id: string
  name: string
  email: string | null
}

export interface SupportTicket {
  uuid: string
  // Human-friendly sequential id (e.g. 1024). Nullable for any legacy ticket
  // created before this feature shipped that hasn't been backfilled yet.
  ticket_number: number | null
  subject: string
  status: 'open' | 'in_progress' | 'closed'
  priority: 'low' | 'normal' | 'high'
  // What kind of request this is. Null for legacy tickets created before
  // classification shipped, or when the requester didn't pick one.
  classification: 'bug' | 'enhancement' | 'feature_request' | null
  user_id: string
  user_name: string | null
  user_email: string | null
  team_id: string | null
  assigned_to: string | null
  category: string | null
  // Only present for support agents — backend strips this for ticket owners.
  tags?: string[]
  // Users tagged to follow the ticket. Visible to anyone who can see it.
  watchers: SupportWatcher[]
  messages: SupportMessage[]
  attachments: SupportAttachment[]
  message_count: number
  created_at: string | null
  updated_at: string | null
  closed_at: string | null
}

export interface SupportTicketSummary {
  uuid: string
  ticket_number: number | null
  subject: string
  status: 'open' | 'in_progress' | 'closed'
  priority: 'low' | 'normal' | 'high'
  classification: 'bug' | 'enhancement' | 'feature_request' | null
  user_id: string
  user_name: string | null
  assigned_to: string | null
  category: string | null
  // Only present for support agents — backend strips this for ticket owners.
  tags?: string[]
  // user_ids of watchers; used to render a "Watching" badge without a detail fetch.
  watcher_ids: string[]
  message_count: number
  last_message_preview: string | null
  last_message_at: string | null
  last_message_is_support_reply: boolean | null
  last_message_is_internal_note?: boolean | null
  last_message_user_id: string | null
  read_by: string[]
  created_at: string | null
  updated_at: string | null
  closed_at: string | null
}

export interface SupportContact {
  user_id: string
  email: string
  name: string
}

// ---------------------------------------------------------------------------
// Queue filters, as they live in the URL
// ---------------------------------------------------------------------------

/**
 * Declared here so the route that validates these and the page that updates
 * them agree on one shape. They were previously declared in both places: the
 * route's `validateSearch` returned every key, which TypeScript infers as
 * required-but-possibly-undefined, while the page declared them optional. Any
 * partial update — `search={{ ticket: undefined }}`, or a reducer spreading
 * `prev` — then failed to typecheck against the route.
 *
 * Optional is the honest shape: `validateSearch` returns `undefined` for every
 * absent or unrecognized value, so a missing key and a key set to `undefined`
 * mean the same thing, and a caller should be free to pass either.
 */
export type StatusFilter = 'all' | 'open' | 'in_progress' | 'closed'
export type PriorityFilter = 'all' | 'low' | 'normal' | 'high'
export type ClassificationFilter = 'all' | 'bug' | 'enhancement' | 'feature_request'

export type SupportSearch = {
  ticket?: string
  status?: StatusFilter
  priority?: PriorityFilter
  classification?: ClassificationFilter
  tag?: string
  q?: string
}
