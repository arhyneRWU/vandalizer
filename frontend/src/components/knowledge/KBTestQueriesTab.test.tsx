import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { KBTestQueriesTab } from './KBTestQueriesTab'
import type { KBTestQuery } from '../../api/knowledge'

const bulkDeleteKBTestQueries = vi.fn().mockResolvedValue({ deleted: 2 })
const confirmFn = vi.fn().mockResolvedValue(true)

vi.mock('../../api/knowledge', () => ({
  createKBTestQuery: vi.fn(),
  updateKBTestQuery: vi.fn(),
  deleteKBTestQuery: vi.fn(),
  bulkDeleteKBTestQueries: (uuid: string, uuids: string[]) => bulkDeleteKBTestQueries(uuid, uuids),
  generateKBTestQueriesAndWait: vi.fn(),
}))
vi.mock('./GenerateTestQueriesModal', () => ({ GenerateTestQueriesModal: () => null }))
vi.mock('./ImportTestQueriesModal', () => ({ ImportTestQueriesModal: () => null }))
vi.mock('../shared/useConfirm', () => ({ useConfirm: () => confirmFn }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))

function q(uuid: string, query: string, auto: boolean): KBTestQuery {
  return {
    uuid,
    query,
    expected_source_labels: [],
    expected_answer_contains: null,
    expected_answer: null,
    category: null,
    notes: null,
    external_id: null,
    auto_generated: auto,
    source_chunk_ids: [],
    last_judged_score: null,
    last_judged_at: null,
    created_at: null,
    updated_at: null,
  }
}

const QUERIES = [
  q('q-1', 'Hand-written question?', false),
  q('q-2', 'Generated question A?', true),
  q('q-3', 'Generated question B?', true),
]

function renderTab(props: Partial<Parameters<typeof KBTestQueriesTab>[0]> = {}) {
  const onChange = vi.fn()
  render(
    <KBTestQueriesTab
      kbUuid="kb-1"
      kbReady
      canManage
      queries={QUERIES}
      onChange={onChange}
      {...props}
    />,
  )
  return { onChange }
}

// Support ticket: KBs accumulate hundreds of imported/auto-generated test
// queries and the tab only offered row-by-row deletion.
describe('KBTestQueriesTab bulk deletion', () => {
  beforeEach(() => {
    bulkDeleteKBTestQueries.mockClear()
    confirmFn.mockClear()
  })

  it('deletes every selected query in one call', async () => {
    const { onChange } = renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: /Select all/ }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(3\)/ }))

    await waitFor(() => expect(bulkDeleteKBTestQueries).toHaveBeenCalledTimes(1))
    expect(bulkDeleteKBTestQueries).toHaveBeenCalledWith('kb-1', ['q-1', 'q-2', 'q-3'])
    expect(confirmFn).toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('scopes "select all" to the active author filter', async () => {
    renderTab()

    fireEvent.click(screen.getByRole('button', { name: 'Auto-generated (2)' }))
    expect(screen.queryByText('Hand-written question?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: /Select all auto-generated/ }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(2\)/ }))

    await waitFor(() =>
      expect(bulkDeleteKBTestQueries).toHaveBeenCalledWith('kb-1', ['q-2', 'q-3']),
    )
  })

  it('does not delete when the confirmation is declined', async () => {
    confirmFn.mockResolvedValueOnce(false)
    renderTab()

    fireEvent.click(screen.getByRole('checkbox', { name: /Select test query: Hand-written/ }))
    fireEvent.click(screen.getByRole('button', { name: /Delete selected \(1\)/ }))

    await waitFor(() => expect(confirmFn).toHaveBeenCalled())
    expect(bulkDeleteKBTestQueries).not.toHaveBeenCalled()
  })

  it('hides selection affordances for a view-only user', () => {
    renderTab({ canManage: false })

    expect(screen.queryByRole('checkbox', { name: /Select all/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Select test query/ })).not.toBeInTheDocument()
    // Filtering stays available — it is read-only.
    expect(screen.getByRole('button', { name: 'User-authored (1)' })).toBeInTheDocument()
  })
})
