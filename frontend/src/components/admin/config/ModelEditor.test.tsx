import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRef } from 'react'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { ModelEditor, type ModelEditorHandle } from './ModelEditor'
import type { SystemConfigData } from '../../../api/admin'

// ---------------------------------------------------------------------------
// The Available Models panel, tested in isolation — which is the point of
// extracting it from ConfigTab (plan 013). Covers its own save path, its
// id-addressed writes (plan 011), and the imperative first-run hook the setup
// checklist uses.
// ---------------------------------------------------------------------------

const mockAddModel = vi.fn()
const mockUpdateModel = vi.fn()
const mockDeleteModel = vi.fn()
const mockSetDefaultModel = vi.fn()
const mockTestModel = vi.fn()
const mockProbeModel = vi.fn()

vi.mock('../../../api/admin', () => ({
  addModel: (...a: unknown[]) => mockAddModel(...a),
  updateModel: (...a: unknown[]) => mockUpdateModel(...a),
  deleteModel: (...a: unknown[]) => mockDeleteModel(...a),
  setDefaultModel: (...a: unknown[]) => mockSetDefaultModel(...a),
  testModel: (...a: unknown[]) => mockTestModel(...a),
  probeModel: (...a: unknown[]) => mockProbeModel(...a),
}))

const mockConfirm = vi.fn()

vi.mock('../../shared/useConfirm', () => ({
  useConfirm: () => mockConfirm,
}))

type ModelList = SystemConfigData['available_models']

const MODELS: ModelList = [
  { id: 'model-alpha', name: 'gpt-4o', tag: 'openai', external: true, thinking: false, api_protocol: 'openai', endpoint: 'https://api.openai.com/v1', context_window: 128000 },
  { id: 'model-beta', name: 'llama3.1', tag: 'ollama', external: false, thinking: false, api_protocol: 'ollama', endpoint: 'http://localhost:11434/v1', context_window: 32768 },
]

const onConfigPatch = vi.fn()
const onReadinessChange = vi.fn()
const onError = vi.fn()

function renderPanel(models: ModelList = MODELS, ref?: React.Ref<ModelEditorHandle>) {
  return render(
    <ModelEditor
      ref={ref}
      models={models}
      defaultModel="gpt-4o"
      onConfigPatch={onConfigPatch}
      onReadinessChange={onReadinessChange}
      error={null}
      onError={onError}
    />,
  )
}

beforeEach(() => {
  mockAddModel.mockReset()
  mockUpdateModel.mockReset()
  mockDeleteModel.mockReset().mockResolvedValue({ status: 'ok' })
  mockSetDefaultModel.mockReset().mockResolvedValue({ status: 'ok', default_model: '' })
  mockTestModel.mockReset().mockResolvedValue({ ok: true, checks: [], summary: 'Connected' })
  mockProbeModel.mockReset()
  mockConfirm.mockReset().mockResolvedValue(true)
  onConfigPatch.mockReset()
  onReadinessChange.mockReset()
  onError.mockReset()
})

describe('ModelEditor — list', () => {
  it('renders each model with its tag and marks the default', () => {
    renderPanel()

    expect(screen.getByText('gpt-4o')).toBeInTheDocument()
    expect(screen.getByText('llama3.1')).toBeInTheDocument()
    expect(screen.getByText('Default')).toBeInTheDocument()
    expect(screen.getByTitle('Remove as default')).toBeInTheDocument()
  })

  it('renders an empty state with no models', () => {
    renderPanel([])

    expect(screen.getByText('No models configured.')).toBeInTheDocument()
  })
})

describe('ModelEditor — save path', () => {
  it('adds a model through the provider wizard, then tests it by returned id', async () => {
    mockAddModel.mockResolvedValue({
      status: 'ok',
      models: [...MODELS, { id: 'model-gamma', name: 'gpt-4o-mini', tag: 'openai', external: true, thinking: false }],
    })

    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))

    // Step 1 — pick a provider; its preset fills in the technical fields.
    fireEvent.click(screen.getByRole('button', { name: /OpenAI GPT models from the OpenAI API\./ }))
    // Step 2 — the admin only has to supply a name.
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'gpt-4o-mini' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save & test connection' }))

    await waitFor(() => expect(mockAddModel).toHaveBeenCalledTimes(1))
    expect(mockAddModel).toHaveBeenCalledWith(expect.objectContaining({
      name: 'gpt-4o-mini',
      tag: 'openai',
      api_protocol: 'openai',
      endpoint: 'https://api.openai.com/v1',
      external: true,
    }))

    // The new list is handed back to the parent, and the connection test runs
    // against the id the backend just returned.
    await waitFor(() => expect(onConfigPatch).toHaveBeenCalledTimes(1))
    const patch = onConfigPatch.mock.calls[0][0] as Record<string, unknown>
    expect((patch.available_models as ModelList).map(m => m.id)).toEqual(['model-alpha', 'model-beta', 'model-gamma'])
    expect('default_model' in patch).toBe(false)
    await waitFor(() => expect(mockTestModel).toHaveBeenCalledWith('model-gamma'))
    expect(onReadinessChange).toHaveBeenCalled()
  })

  it('updates an existing model by its stable id, not its position (plan 011)', async () => {
    mockUpdateModel.mockResolvedValue({ status: 'ok', models: MODELS })

    renderPanel()
    fireEvent.click(screen.getAllByTitle('Edit model')[1])
    fireEvent.click(screen.getByRole('button', { name: 'Save & test connection' }))

    await waitFor(() => expect(mockUpdateModel).toHaveBeenCalledTimes(1))
    expect(mockUpdateModel.mock.calls[0][0]).toBe('model-beta')
    expect(mockUpdateModel.mock.calls[0][1]).toEqual(expect.objectContaining({ name: 'llama3.1', tag: 'ollama' }))
  })

  it('refuses to save a model with no name and reports it upward', async () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
    fireEvent.click(screen.getByRole('button', { name: /OpenAI GPT models from the OpenAI API\./ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save & test connection' }))

    await waitFor(() => expect(onError).toHaveBeenCalledWith('Enter a model name'))
    expect(mockAddModel).not.toHaveBeenCalled()
  })
})

describe('ModelEditor — delete and default', () => {
  it('deletes by id and hands the parent the remaining list', async () => {
    renderPanel()
    fireEvent.click(screen.getAllByTitle('Delete model')[1])

    await waitFor(() => expect(mockDeleteModel).toHaveBeenCalledWith('model-beta'))
    await waitFor(() => expect(onConfigPatch).toHaveBeenCalledTimes(1))
    const patch = onConfigPatch.mock.calls[0][0] as Record<string, unknown>
    expect((patch.available_models as ModelList).map(m => m.id)).toEqual(['model-alpha'])
    expect(onReadinessChange).toHaveBeenCalled()
  })

  it('does not delete when the confirmation is declined', async () => {
    mockConfirm.mockResolvedValue(false)
    renderPanel()
    fireEvent.click(screen.getAllByTitle('Delete model')[1])

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled())
    expect(mockDeleteModel).not.toHaveBeenCalled()
    expect(onConfigPatch).not.toHaveBeenCalled()
  })

  it('toggles the default model off when the current default is clicked', async () => {
    renderPanel()
    fireEvent.click(screen.getByTitle('Remove as default'))

    await waitFor(() => expect(mockSetDefaultModel).toHaveBeenCalledWith(''))
    expect(onConfigPatch).toHaveBeenCalledWith({ default_model: '' })
  })
})

describe('ModelEditor — first-run wizard hook', () => {
  it('opens the wizard when the setup checklist asks and no model exists', () => {
    const ref = createRef<ModelEditorHandle>()
    renderPanel([], ref)

    expect(screen.queryByText('Add a model')).not.toBeInTheDocument()
    act(() => ref.current?.openFirstRunWizard())
    expect(screen.getByText('Add a model')).toBeInTheDocument()
  })

  it('leaves the panel alone when models already exist', () => {
    const ref = createRef<ModelEditorHandle>()
    renderPanel(MODELS, ref)

    act(() => ref.current?.openFirstRunWizard())
    expect(screen.queryByText('Add a model')).not.toBeInTheDocument()
  })

  it('does not clobber an open draft', () => {
    const ref = createRef<ModelEditorHandle>()
    renderPanel([], ref)

    fireEvent.click(screen.getByRole('button', { name: /Add Model/ }))
    fireEvent.click(screen.getByRole('button', { name: /OpenAI GPT models from the OpenAI API\./ }))
    fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'half-typed' } })

    act(() => ref.current?.openFirstRunWizard())
    expect(screen.getByLabelText('Model name')).toHaveValue('half-typed')
  })
})
