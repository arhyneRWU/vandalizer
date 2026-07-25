import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuditTab } from './AuditTab'
import type { AuditLogEntry } from '../../api/audit'

const mockQueryAuditLog = vi.fn()

vi.mock('../../api/audit', () => ({
  queryAuditLog: (...args: unknown[]) => mockQueryAuditLog(...args),
  exportAuditLog: () => '#',
}))

const entry: AuditLogEntry = {
  uuid: 'entry-1',
  timestamp: '2026-01-01T00:00:00Z',
  actor_user_id: 'user-1',
  actor_type: 'user',
  action: 'document.create',
  resource_type: 'document',
  resource_id: 'doc-1',
  resource_name: 'Some Doc',
  team_id: null,
  organization_id: null,
  detail: {},
  ip_address: null,
}

beforeEach(() => {
  mockQueryAuditLog.mockReset()
})

describe('AuditTab — success', () => {
  it('renders entries and the total count on success', async () => {
    mockQueryAuditLog.mockResolvedValue({ entries: [entry], total: 1, skip: 0, limit: 25 })
    render(<AuditTab />)
    await waitFor(() => expect(screen.getByText('Some Doc')).toBeInTheDocument())
    expect(screen.getByText('(1 entries)')).toBeInTheDocument()
  })
})

describe('AuditTab — rejected query (regression for plan 005)', () => {
  it('does not render "No entries found" or a "(0 entries)" count on a rejected query', async () => {
    mockQueryAuditLog.mockRejectedValue(new Error('boom'))
    render(<AuditTab />)
    await waitFor(() => expect(screen.getByText('Failed to load audit log')).toBeInTheDocument())
    expect(screen.queryByText('No entries found')).not.toBeInTheDocument()
    expect(screen.queryByText('(0 entries)')).not.toBeInTheDocument()
  })
})

describe('AuditTab — filters', () => {
  it('resets to the first page when a filter changes', async () => {
    mockQueryAuditLog.mockResolvedValue({
      entries: Array.from({ length: 25 }, (_, i) => ({ ...entry, uuid: `e${i}` })),
      total: 60,
      skip: 0,
      limit: 25,
    })
    render(<AuditTab />)
    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: /next/i }))
    await waitFor(() => expect(mockQueryAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 25 }),
    ))
    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('Filter by action…'), { target: { value: 'document.create' } })
    await waitFor(() => expect(mockQueryAuditLog).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 0, action: 'document.create' }),
    ))
    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument())
  })
})
