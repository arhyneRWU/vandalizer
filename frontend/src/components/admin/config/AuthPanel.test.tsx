import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { AuthPanel } from './AuthPanel'
import type { SystemConfigData } from '../../../api/admin'

// ---------------------------------------------------------------------------
// The Authentication + OAuth/SAML panel in isolation (plan 013). This is the
// highest-stakes panel in the admin surface: an empty auth_methods list
// disables every login path, and a mishandled client secret destroys a working
// SSO integration. Both guards are covered here.
// ---------------------------------------------------------------------------

const mockGetSystemConfig = vi.fn()
const mockAddOAuthProvider = vi.fn()
const mockUpdateOAuthProvider = vi.fn()
const mockDeleteOAuthProvider = vi.fn()
const mockUpdateAuthMethods = vi.fn()
const mockParseSamlMetadata = vi.fn()

vi.mock('../../../api/admin', () => ({
  getSystemConfig: (...a: unknown[]) => mockGetSystemConfig(...a),
  addOAuthProvider: (...a: unknown[]) => mockAddOAuthProvider(...a),
  updateOAuthProvider: (...a: unknown[]) => mockUpdateOAuthProvider(...a),
  deleteOAuthProvider: (...a: unknown[]) => mockDeleteOAuthProvider(...a),
  updateAuthMethods: (...a: unknown[]) => mockUpdateAuthMethods(...a),
  parseSamlMetadata: (...a: unknown[]) => mockParseSamlMetadata(...a),
}))

const mockConfirm = vi.fn()

vi.mock('../../shared/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}))

const PROVIDERS: SystemConfigData['oauth_providers'] = [
  { id: 'prov-1', provider: 'azure', display_name: 'Campus Azure', client_id: 'client-abc', tenant_id: 'tenant-1', redirect_uri: '' },
]

const onConfigReplace = vi.fn()
const onReadinessChange = vi.fn()
const onError = vi.fn()

function renderPanel(
  authMethods: string[] = ['password', 'oauth'],
  providers: SystemConfigData['oauth_providers'] = PROVIDERS,
) {
  return render(
    <AuthPanel
      providers={providers}
      initialAuthMethods={authMethods}
      onConfigReplace={onConfigReplace}
      onReadinessChange={onReadinessChange}
      onError={onError}
    />,
  )
}

beforeEach(() => {
  mockGetSystemConfig.mockReset().mockResolvedValue({ oauth_providers: PROVIDERS } as SystemConfigData)
  mockAddOAuthProvider.mockReset().mockResolvedValue({ status: 'ok' })
  mockUpdateOAuthProvider.mockReset().mockResolvedValue({ status: 'ok' })
  mockDeleteOAuthProvider.mockReset().mockResolvedValue({ status: 'ok' })
  mockUpdateAuthMethods.mockReset().mockResolvedValue({ status: 'ok' })
  mockParseSamlMetadata.mockReset()
  mockConfirm.mockReset().mockResolvedValue(true)
  onConfigReplace.mockReset()
  onReadinessChange.mockReset()
  onError.mockReset()
})

describe('AuthPanel — auth methods floor (plan 003)', () => {
  it('disables the only enabled method', () => {
    renderPanel(['password'])

    expect(screen.getByLabelText('password')).toBeDisabled()
    expect(screen.getByLabelText('OAuth / SAML')).not.toBeDisabled()
  })

  it('re-disables the survivor once the other method is unchecked', () => {
    renderPanel(['password', 'oauth'])

    expect(screen.getByLabelText('password')).not.toBeDisabled()
    fireEvent.click(screen.getByLabelText('OAuth / SAML'))
    // Only "password" is left, so it must no longer be uncheckable.
    expect(screen.getByLabelText('password')).toBeDisabled()
  })

  it('saves the current selection and re-grades readiness', async () => {
    renderPanel(['password'])

    fireEvent.click(screen.getByLabelText('OAuth / SAML'))
    fireEvent.click(screen.getByRole('button', { name: 'Update Methods' }))

    await waitFor(() => expect(mockUpdateAuthMethods).toHaveBeenCalledWith(['password', 'oauth']))
    await waitFor(() => expect(onReadinessChange).toHaveBeenCalled())
  })

  it('reports a rejected save to the tab-level error banner', async () => {
    mockUpdateAuthMethods.mockRejectedValue(new Error('at least one method required'))
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Update Methods' }))
    await waitFor(() => expect(onError).toHaveBeenCalledWith('at least one method required'))
  })
})

describe('AuthPanel — provider list', () => {
  it('renders configured providers', () => {
    renderPanel()

    expect(screen.getByText('Campus Azure')).toBeInTheDocument()
    expect(screen.getByText('AZURE')).toBeInTheDocument()
  })

  it('renders an empty state with no providers', () => {
    renderPanel(['password', 'oauth'], [])

    expect(screen.getByText('No providers configured.')).toBeInTheDocument()
  })
})

describe('AuthPanel — client secret sentinel (plans 003 / 011)', () => {
  it('prefills "***" on edit and echoes it back, so the stored secret survives', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Edit provider' }))
    expect(await screen.findByLabelText('Client Secret')).toHaveValue('***')

    fireEvent.change(screen.getByLabelText('Display Name'), { target: { value: 'Campus Azure AD' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(mockUpdateOAuthProvider).toHaveBeenCalledTimes(1))
    const [providerId, payload] = mockUpdateOAuthProvider.mock.calls[0] as [string, Record<string, unknown>]
    // Addressed by stable id, never by list position (plan 011).
    expect(providerId).toBe('prov-1')
    expect(payload.client_secret).toBe('***')
    expect(payload.client_secret).not.toBe('')
    expect(payload.display_name).toBe('Campus Azure AD')
    // The write is followed by a config re-read handed back to the parent.
    await waitFor(() => expect(onConfigReplace).toHaveBeenCalledTimes(1))
  })

  it('sends a genuinely retyped secret verbatim', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Edit provider' }))
    fireEvent.change(await screen.findByLabelText('Client Secret'), { target: { value: 'rotated-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }))

    await waitFor(() => expect(mockUpdateOAuthProvider).toHaveBeenCalledTimes(1))
    expect((mockUpdateOAuthProvider.mock.calls[0][1] as Record<string, unknown>).client_secret).toBe('rotated-secret')
  })
})

describe('AuthPanel — add and delete', () => {
  it('rejects a provider with no display name before calling the API', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/ }))
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Provider' }).slice(-1)[0])

    expect(await screen.findByRole('alert')).toHaveTextContent('Display name is required.')
    expect(mockAddOAuthProvider).not.toHaveBeenCalled()
  })

  it('adds a provider and refreshes the config', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/ }))
    const form = screen.getByText('New Provider').parentElement!
    fireEvent.change(formField(form, 'Display Name'), { target: { value: 'New IdP' } })
    fireEvent.change(formField(form, 'Client ID'), { target: { value: 'cid-9' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Provider' }).slice(-1)[0])

    await waitFor(() => expect(mockAddOAuthProvider).toHaveBeenCalledWith(expect.objectContaining({
      display_name: 'New IdP',
      client_id: 'cid-9',
      provider: 'oauth',
    })))
    await waitFor(() => expect(onConfigReplace).toHaveBeenCalledTimes(1))
  })

  it('deletes a provider by id after confirmation', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }))
    await waitFor(() => expect(mockDeleteOAuthProvider).toHaveBeenCalledWith('prov-1'))
    await waitFor(() => expect(onConfigReplace).toHaveBeenCalledTimes(1))
  })

  it('does not delete when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false)
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Delete provider' }))
    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockDeleteOAuthProvider).not.toHaveBeenCalled()
  })

  it('requires the IdP fields for a SAML provider', async () => {
    renderPanel()

    fireEvent.click(screen.getByRole('button', { name: /Add Provider/ }))
    const form = screen.getByText('New Provider').parentElement!
    fireEvent.change(formField(form, 'Display Name'), { target: { value: 'Shibboleth' } })
    fireEvent.change(formField(form, 'Type'), { target: { value: 'saml' } })
    fireEvent.click(screen.getAllByRole('button', { name: 'Add Provider' }).slice(-1)[0])

    expect(await screen.findByRole('alert')).toHaveTextContent('SAML requires the IdP Entity ID')
    expect(mockAddOAuthProvider).not.toHaveBeenCalled()
  })
})

/** The "New Provider" form's labels are not htmlFor-associated, so resolve a
 *  field by the label text that precedes it inside the form. */
function formField(form: HTMLElement, labelText: string): HTMLElement {
  const label = Array.from(form.querySelectorAll('label')).find(l => l.textContent?.startsWith(labelText))
  const field = label?.parentElement?.querySelector('input, select, textarea')
  if (!field) throw new Error(`field "${labelText}" not found`)
  return field as HTMLElement
}
