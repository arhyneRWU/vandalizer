import { useEffect, useState, useCallback, useRef } from 'react'
import {
  ShieldCheck, Users, Settings,
  Palette, Cpu, Lock, Globe, Plus, Trash2, Pencil,
  CheckCircle2, XCircle,
  Play, AlertCircle,
  X,
} from 'lucide-react'
import { useConfirm } from '../shared/useConfirm'
import { getThemeConfig, updateThemeConfig } from '../../api/config'
import type { ThemeConfig } from '../../api/config'
import { useBranding, DEFAULT_ORG_NAME, DEFAULT_ICON_URL } from '../../contexts/BrandingContext'
import {
  getSystemConfig, updateSystemConfig, updateCompliancePolicyConfig,
  testOcr, testPrompt, getReadiness, addOAuthProvider,
  updateOAuthProvider, deleteOAuthProvider, updateAuthMethods, parseSamlMetadata,
} from '../../api/admin'
import type { TestPromptResult, ReadinessReport, ReadinessItem } from '../../api/admin'
import type {
  SystemConfigData,
} from '../../api/admin'
import { fileToConstrainedDataUrl } from '../../utils/imageResize'
import { ModelEditor } from './config/ModelEditor'
import type { ModelEditorHandle } from './config/ModelEditor'
import { sectionStyle, sectionHeaderStyle, sectionBodyStyle, labelStyle, inputStyle, checkStyle } from './config/styles'

function applyThemeToDOM(theme: ThemeConfig) {
  const root = document.documentElement
  root.style.setProperty('--highlight-color', theme.highlight_color)
  root.style.setProperty('--ui-radius', theme.ui_radius)
}

const MAX_LOGO_BYTES = 500_000 // matches backend cap on the encoded data URL

// ──────────────────────────────────────────
// Setup readiness checklist
// ──────────────────────────────────────────

// A graded "is this install set up" surface. A dismissible banner auto-shows
// while a blocker (no working LLM) is unresolved; the full checklist always
// lives at the top of the config page. `onJump` scrolls to the relevant
// section so each item is one click from being fixed.
function SetupChecklist({ report, onJump, onDismiss }: { report: ReadinessReport; onJump: (target: string) => void; onDismiss?: () => void }) {
  const sevColor: Record<string, string> = { blocker: '#dc2626', recommended: '#d97706', optional: '#6b7280' }
  const statusPill = (item: ReadinessItem) => {
    if (item.status === 'configured') return { label: 'Done', bg: '#dcfce7', fg: '#166534' }
    if (item.status === 'incomplete') return { label: 'Needs attention', bg: '#fef9c3', fg: '#854d0e' }
    return item.severity === 'blocker'
      ? { label: 'Required', bg: '#fee2e2', fg: '#991b1b' }
      : { label: 'Recommended', bg: '#ffedd5', fg: '#9a3412' }
  }
  return (
    <div style={{ marginBottom: 20, border: '1px solid #e5e7eb', borderRadius: 'var(--ui-radius, 12px)', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #f1f5f9', display: 'flex', alignItems: 'center', gap: 8 }}>
        {report.ready
          ? <ShieldCheck size={18} style={{ color: '#16a34a' }} />
          : <AlertCircle size={18} style={{ color: '#d97706' }} />}
        <span style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>
          {report.ready ? 'System ready' : 'Finish setting up your workspace'}
        </span>
        {!report.ready && report.blockers_remaining > 0 && (
          <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 9999, background: '#fee2e2', color: '#991b1b' }}>
            {report.blockers_remaining} blocker{report.blockers_remaining > 1 ? 's' : ''} left
          </span>
        )}
        <div style={{ flex: 1 }} />
        {onDismiss && (
          <button onClick={onDismiss} title="Dismiss" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9ca3af', padding: 2 }}>
            <X size={16} />
          </button>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {report.items.map(item => {
          const pill = statusPill(item)
          const done = item.status === 'configured'
          return (
            <div key={item.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 16px', borderTop: '1px solid #f8fafc' }}>
              <div style={{ marginTop: 1 }}>
                {done
                  ? <CheckCircle2 size={18} style={{ color: '#16a34a' }} />
                  : <div style={{ width: 18, height: 18, borderRadius: 9999, border: `2px solid ${sevColor[item.severity]}` }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{item.title}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 9999, background: pill.bg, color: pill.fg }}>{pill.label}</span>
                </div>
                <div style={{ fontSize: 12, color: '#4b5563', marginTop: 2 }}>{item.summary}</div>
                {!done && <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>Unlocks: {item.unlocks}</div>}
              </div>
              {!done && (
                <button
                  onClick={() => onJump(item.action_target)}
                  style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db', background: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#111' }}
                >
                  {item.action_label}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ──────────────────────────────────────────
// Config Tab
// ──────────────────────────────────────────

export function ConfigTab() {
  const confirm = useConfirm()
  const [cfg, setCfg] = useState<SystemConfigData | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Theme state
  const branding = useBranding()
  const [themeColor, setThemeColor] = useState('#eab308')
  const [themeRadius, setThemeRadius] = useState(12)
  const [themeOrgName, setThemeOrgName] = useState('')
  const [themeLogo, setThemeLogo] = useState('')
  const [themeLogoError, setThemeLogoError] = useState<string | null>(null)
  const [themeIcon, setThemeIcon] = useState('')
  const [themeIconError, setThemeIconError] = useState<string | null>(null)
  const [themeIconHideInNav, setThemeIconHideInNav] = useState(false)
  const [themeSaving, setThemeSaving] = useState(false)
  const [themeSaved, setThemeSaved] = useState(false)

  // Extraction config
  const [extractionMode, setExtractionMode] = useState('one_pass')
  const [chunkingEnabled, setChunkingEnabled] = useState(false)
  const [maxKeysPerChunk, setMaxKeysPerChunk] = useState(10)
  const [repetitionEnabled, setRepetitionEnabled] = useState(false)
  const [onePassThinking, setOnePassThinking] = useState(true)
  const [onePassStructured, setOnePassStructured] = useState(true)
  const [onePassModel, setOnePassModel] = useState('')
  const [twoPassP1Thinking, setTwoPassP1Thinking] = useState(true)
  const [twoPassP1Structured, setTwoPassP1Structured] = useState(false)
  const [twoPassP1Model, setTwoPassP1Model] = useState('')
  const [twoPassP2Thinking, setTwoPassP2Thinking] = useState(false)
  const [twoPassP2Structured, setTwoPassP2Structured] = useState(true)
  const [twoPassP2Model, setTwoPassP2Model] = useState('')
  const [useImages, setUseImages] = useState(false)

  // Quality config
  const [requireValidation, setRequireValidation] = useState(false)
  const [minAccuracy, setMinAccuracy] = useState(70)
  const [minConsistency, setMinConsistency] = useState(80)
  const [minWorkflowGrade, setMinWorkflowGrade] = useState('C')
  const [excellentThreshold, setExcellentThreshold] = useState(90)
  const [goodThreshold, setGoodThreshold] = useState(70)
  const [fairThreshold, setFairThreshold] = useState(50)

  // Endpoints
  const [ocrEndpoint, setOcrEndpoint] = useState('')
  const [ocrApiKey, setOcrApiKey] = useState('')
  // Tracks whether the user actually edited the key field (vs. it merely
  // holding the load's initial value). Only a dirty key is sent on save —
  // this is defense in depth so a form rendered without a successful config
  // load can never overwrite the stored key with ''. See the `!cfg || loadError`
  // early return below, which is the primary guard.
  const [ocrApiKeyDirty, setOcrApiKeyDirty] = useState(false)
  const [ocrTesting, setOcrTesting] = useState(false)
  const [ocrTestResult, setOcrTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  // System readiness / setup checklist
  const [readiness, setReadiness] = useState<ReadinessReport | null>(null)
  const [setupDismissed, setSetupDismissed] = useState(false)
  const refreshReadiness = useCallback(async () => {
    try {
      setReadiness(await getReadiness())
    } catch {
      // Readiness is advisory — never block the config page on it.
    }
  }, [])

  // Available Models panel. It owns the model list's own state and save path;
  // the parent keeps the loaded config in sync (the Prompt Playground and the
  // Extraction Configuration panel both read `available_models`) and lends the
  // panel the shared error banner.
  const modelEditorRef = useRef<ModelEditorHandle>(null)
  const applyModelConfigPatch = useCallback((patch: {
    available_models?: SystemConfigData['available_models']
    default_model?: string
  }) => {
    setCfg(prev => (prev ? { ...prev, ...patch } : prev))
  }, [])

  // Prompt playground
  const [playgroundModel, setPlaygroundModel] = useState('')
  const [playgroundSystem, setPlaygroundSystem] = useState('')
  const [playgroundUser, setPlaygroundUser] = useState('')
  const [playgroundSending, setPlaygroundSending] = useState(false)
  const [playgroundResult, setPlaygroundResult] = useState<TestPromptResult | null>(null)
  const [playgroundError, setPlaygroundError] = useState<string | null>(null)

  // Auth
  const [authMethods, setAuthMethods] = useState<string[]>(['password'])
  const [authSaving, setAuthSaving] = useState(false)

  // Support contacts
  const [supportContacts, setSupportContacts] = useState<{ user_id: string; email: string; name: string }[]>([])
  const [showAddContact, setShowAddContact] = useState(false)
  const [newContact, setNewContact] = useState({ user_id: '', email: '', name: '' })

  // Compliance activation
  const [complianceEnabled, setComplianceEnabled] = useState(false)
  const [complianceCheckOnUpload, setComplianceCheckOnUpload] = useState(true)
  const [complianceRules, setComplianceRules] = useState('')
  const [complianceChunkSize, setComplianceChunkSize] = useState(8000)
  const [complianceChunkOverlap, setComplianceChunkOverlap] = useState(200)
  const [complianceSaving, setComplianceSaving] = useState(false)
  const [complianceSaved, setComplianceSaved] = useState(false)

  // Retention policy
  type RetentionPolicyForm = { retention_days: number; soft_delete_grace_days: number; warning_days_before?: number }
  const [retentionEnabled, setRetentionEnabled] = useState(false)
  const [retentionPolicies, setRetentionPolicies] = useState<Record<string, RetentionPolicyForm>>({})
  const [activityRetentionDays, setActivityRetentionDays] = useState(180)
  const [chatRetentionDays, setChatRetentionDays] = useState(365)
  const [workflowResultRetentionDays, setWorkflowResultRetentionDays] = useState(365)
  const [staleActivityMinutes, setStaleActivityMinutes] = useState(30)
  const [retentionSaving, setRetentionSaving] = useState(false)
  const [retentionSaved, setRetentionSaved] = useState(false)

  // Add/edit provider form
  const [showAddProvider, setShowAddProvider] = useState(false)
  const [newProvider, setNewProvider] = useState({ provider: 'oauth', display_name: '', client_id: '', client_secret: '', redirect_uri: '', tenant_id: '', idp_entity_id: '', idp_sso_url: '', idp_x509_cert: '' })
  const [editingProviderIndex, setEditingProviderIndex] = useState<number | null>(null)
  const [editingProvider, setEditingProvider] = useState({ provider: 'oauth', display_name: '', client_id: '', client_secret: '', redirect_uri: '', tenant_id: '', idp_entity_id: '', idp_sso_url: '', idp_x509_cert: '' })
  const [samlMeta, setSamlMeta] = useState('')
  const [samlMetaBusy, setSamlMetaBusy] = useState(false)
  const [samlMetaError, setSamlMetaError] = useState('')
  const [providerError, setProviderError] = useState('')

  /** Return a message if the provider form is missing a required field, else ''. */
  const providerValidationError = (p: { provider: string; display_name: string; client_id: string; idp_entity_id: string; idp_sso_url: string; idp_x509_cert: string }): string => {
    if (!p.display_name.trim()) return 'Display name is required.'
    if (p.provider === 'saml') {
      if (!p.idp_entity_id.trim() || !p.idp_sso_url.trim() || !p.idp_x509_cert.trim()) {
        return 'SAML requires the IdP Entity ID, SSO URL, and x509 certificate (use "Fetch & fill" to import them).'
      }
    } else if (!p.client_id.trim()) {
      return 'Client ID is required.'
    }
    return ''
  }

  const handleImportSamlMetadata = async () => {
    const raw = samlMeta.trim()
    if (!raw) return
    setSamlMetaBusy(true)
    setSamlMetaError('')
    try {
      const body = raw.startsWith('<') ? { metadata_xml: raw } : { metadata_url: raw }
      const idp = await parseSamlMetadata(body)
      setNewProvider(p => ({ ...p, idp_entity_id: idp.idp_entity_id, idp_sso_url: idp.idp_sso_url, idp_x509_cert: idp.idp_x509_cert }))
    } catch (e) {
      setSamlMetaError(e instanceof Error ? e.message : 'Could not read metadata')
    } finally {
      setSamlMetaBusy(false)
    }
  }

  useEffect(() => { void refreshReadiness() }, [refreshReadiness])

  // Extracted so the error panel's Retry control can re-run the exact same
  // load the mount effect performs, resetting loadError/loading each time.
  const loadConfig = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    return getSystemConfig().then(c => {
      setCfg(c)
      setThemeColor(c.highlight_color || '#eab308')
      setThemeRadius(parseInt(c.ui_radius) || 12)
      setOcrEndpoint(c.ocr_endpoint || '')
      setOcrApiKey(c.ocr_api_key || '')
      setOcrApiKeyDirty(false)
      setAuthMethods(c.auth_methods || ['password'])
      setSupportContacts((c as unknown as Record<string, unknown>).support_contacts as typeof supportContacts || [])
      // Extraction config
      const ec = c.extraction_config || {}
      setExtractionMode((ec as Record<string, unknown>).mode as string || 'one_pass')
      const chunking = (ec as Record<string, unknown>).chunking as Record<string, unknown> || {}
      setChunkingEnabled(!!chunking.enabled)
      setMaxKeysPerChunk((chunking.max_keys_per_chunk as number) || 10)
      setRepetitionEnabled(!!((ec as Record<string, unknown>).repetition as Record<string, unknown>)?.enabled)
      setUseImages(!!(ec as Record<string, unknown>).use_images)
      const onePass = (ec as Record<string, unknown>).one_pass as Record<string, unknown> || {}
      setOnePassThinking(onePass.thinking !== false)
      setOnePassStructured((onePass.structured_output ?? onePass.structured) !== false)
      setOnePassModel((onePass.model as string) || '')
      const twoPass = (ec as Record<string, unknown>).two_pass as Record<string, unknown> || {}
      const pass1 = (twoPass.pass1 as Record<string, unknown> ?? twoPass.pass_1 as Record<string, unknown>) || {}
      const pass2 = (twoPass.pass2 as Record<string, unknown> ?? twoPass.pass_2 as Record<string, unknown>) || {}
      setTwoPassP1Thinking(pass1.thinking !== false)
      setTwoPassP1Structured(!!(pass1.structured_output ?? pass1.structured))
      setTwoPassP1Model((pass1.model as string) || '')
      setTwoPassP2Thinking(!!(pass2.thinking))
      setTwoPassP2Structured((pass2.structured_output ?? pass2.structured) !== false)
      setTwoPassP2Model((pass2.model as string) || '')
      // Quality config
      const qc = (c.quality_config || {}) as Record<string, unknown>
      const gates = (qc.verification_gates || {}) as Record<string, unknown>
      setRequireValidation(!!gates.require_validation)
      setMinAccuracy(Math.round(((gates.min_extraction_accuracy as number) ?? 0.7) * 100))
      setMinConsistency(Math.round(((gates.min_extraction_consistency as number) ?? 0.8) * 100))
      setMinWorkflowGrade((gates.min_workflow_grade as string) || 'C')
      const tiers = (qc.quality_tiers || {}) as Record<string, Record<string, unknown>>
      setExcellentThreshold((tiers.excellent?.min_score as number) ?? 90)
      setGoodThreshold((tiers.good?.min_score as number) ?? 70)
      setFairThreshold((tiers.fair?.min_score as number) ?? 50)
      // Compliance config
      const comp = c.compliance_config || ({} as Partial<typeof c.compliance_config>)
      setComplianceEnabled(!!comp.enabled)
      setComplianceCheckOnUpload(comp.check_on_upload !== false)
      setComplianceRules(comp.rules || '')
      setComplianceChunkSize(comp.chunk_size || 8000)
      setComplianceChunkOverlap(comp.chunk_overlap ?? 200)
      // Retention config
      const rc = (c.retention_config || {}) as Record<string, unknown>
      setRetentionEnabled(!!rc.enabled)
      setRetentionPolicies((rc.policies as Record<string, RetentionPolicyForm>) || {})
      setActivityRetentionDays((rc.activity_retention_days as number) ?? 180)
      setChatRetentionDays((rc.chat_retention_days as number) ?? 365)
      setWorkflowResultRetentionDays((rc.workflow_result_retention_days as number) ?? 365)
      setStaleActivityMinutes((rc.activity_stale_threshold_minutes as number) ?? 30)
    }).catch(e => {
      setLoadError(e instanceof Error ? e.message : 'Failed to load configuration')
    }).finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    void loadConfig()

    getThemeConfig().then(t => {
      setThemeColor(t.highlight_color)
      setThemeRadius(parseInt(t.ui_radius) || 12)
      setThemeOrgName(t.org_name || '')
      setThemeLogo(t.logo_data_url || '')
      setThemeIcon(t.icon_data_url || '')
      setThemeIconHideInNav(!!t.icon_hide_in_nav)
    }).catch(() => {})
  }, [loadConfig])

  const handleSaveConfig = async () => {
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      await updateSystemConfig({
        extraction_config: {
          mode: extractionMode,
          one_pass: { thinking: onePassThinking, structured: onePassStructured, model: onePassModel || '' },
          two_pass: {
            pass_1: { thinking: twoPassP1Thinking, structured: twoPassP1Structured, model: twoPassP1Model || '' },
            pass_2: { thinking: twoPassP2Thinking, structured: twoPassP2Structured, model: twoPassP2Model || '' },
          },
          chunking: { enabled: chunkingEnabled, max_keys_per_chunk: maxKeysPerChunk },
          repetition: { enabled: repetitionEnabled },
          use_images: useImages,
        },
        quality_config: {
          verification_gates: {
            require_validation: requireValidation,
            min_extraction_accuracy: minAccuracy / 100,
            min_extraction_consistency: minConsistency / 100,
            min_workflow_grade: minWorkflowGrade,
          },
          quality_tiers: {
            excellent: { min_score: excellentThreshold },
            good: { min_score: goodThreshold },
            fair: { min_score: fairThreshold },
          },
        },
        ocr_endpoint: ocrEndpoint,
        // Only send the key when the user actually touched the field. An
        // untouched field after a successful load holds the "***" sentinel,
        // which the backend already treats as "keep the stored key" — so
        // omitting it here is equivalent and avoids ever sending ''.
        ...(ocrApiKeyDirty ? { ocr_api_key: ocrApiKey } : {}),
      })
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
      void refreshReadiness()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveTheme = async () => {
    setThemeSaving(true)
    setThemeSaved(false)
    try {
      const updated = await updateThemeConfig({
        highlight_color: themeColor,
        ui_radius: `${themeRadius}px`,
        org_name: themeOrgName.trim(),
        logo_data_url: themeLogo,
        icon_data_url: themeIcon,
        icon_hide_in_nav: themeIconHideInNav,
      })
      applyThemeToDOM(updated)
      await branding.refresh()
      setThemeSaved(true)
      setTimeout(() => setThemeSaved(false), 3000)
    } finally {
      setThemeSaving(false)
    }
  }

  const handleLogoFile = async (file: File | null) => {
    setThemeLogoError(null)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setThemeLogoError('Please choose an image file (PNG, SVG, JPG).')
      return
    }
    try {
      // Auto-downscale oversized raster images so large exports "just work".
      const dataUrl = await fileToConstrainedDataUrl(file, { maxBytes: MAX_LOGO_BYTES, maxDimension: 1024 })
      // Safety net for the rare oversized SVG, which is passed through unresized.
      if (dataUrl.length > MAX_LOGO_BYTES) {
        setThemeLogoError(`Image too large — keep encoded size under ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`)
        return
      }
      setThemeLogo(dataUrl)
    } catch {
      setThemeLogoError('Could not process the selected image. Try a different file.')
    }
  }

  const handleIconFile = async (file: File | null) => {
    setThemeIconError(null)
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setThemeIconError('Please choose an image file (PNG, SVG, JPG).')
      return
    }
    try {
      // Icons/mascots are square-ish and small in the UI, so a tighter max
      // dimension keeps them well under the cap while staying crisp.
      const dataUrl = await fileToConstrainedDataUrl(file, { maxBytes: MAX_LOGO_BYTES, maxDimension: 512 })
      // Safety net for the rare oversized SVG, which is passed through unresized.
      if (dataUrl.length > MAX_LOGO_BYTES) {
        setThemeIconError(`Image too large — keep encoded size under ${Math.round(MAX_LOGO_BYTES / 1024)} KB.`)
        return
      }
      setThemeIcon(dataUrl)
    } catch {
      setThemeIconError('Could not process the selected image. Try a different file.')
    }
  }

  const handleTestOcr = async () => {
    setOcrTesting(true)
    setOcrTestResult(null)
    try {
      // Send the form's current values so unsaved edits are what gets tested;
      // an untouched key field holds the "***" sentinel, meaning the saved key.
      const res = await testOcr({ ocr_endpoint: ocrEndpoint, ocr_api_key: ocrApiKey })
      setOcrTestResult({ ok: true, message: res.message })
    } catch (e) {
      setOcrTestResult({ ok: false, message: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setOcrTesting(false)
    }
  }

  const handleSendPlaygroundPrompt = async () => {
    if (!playgroundUser.trim()) return
    setPlaygroundSending(true)
    setPlaygroundError(null)
    setPlaygroundResult(null)
    try {
      const res = await testPrompt({
        model_name: playgroundModel || cfg?.default_model || '',
        system_prompt: playgroundSystem,
        user_prompt: playgroundUser,
      })
      setPlaygroundResult(res)
    } catch (e) {
      setPlaygroundError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setPlaygroundSending(false)
    }
  }

  const handleSaveAuthMethods = async () => {
    setAuthSaving(true)
    setError(null)
    try {
      await updateAuthMethods(authMethods)
      void refreshReadiness()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update auth methods')
    } finally {
      setAuthSaving(false)
    }
  }

  const handleAddProvider = async () => {
    const validationError = providerValidationError(newProvider)
    if (validationError) { setProviderError(validationError); return }
    setProviderError('')
    try {
      await addOAuthProvider(newProvider as unknown as Record<string, string>)
      // Refresh config
      const c = await getSystemConfig()
      setCfg(c)
      setNewProvider({ provider: 'oauth', display_name: '', client_id: '', client_secret: '', redirect_uri: '', tenant_id: '', idp_entity_id: '', idp_sso_url: '', idp_x509_cert: '' })
      setSamlMeta('')
      setShowAddProvider(false)
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : 'Failed to add provider')
    }
  }

  const handleDeleteProvider = async (index: number) => {
    const provider = cfg?.oauth_providers?.[index] as Record<string, unknown> | undefined
    const name = (provider?.display_name as string) || (provider?.provider as string) || 'this provider'
    const ok = await confirm({
      title: 'Delete OAuth provider?',
      message: (
        <>
          Are you sure you want to delete <strong>{name}</strong>? Users authenticating through this provider will no longer be able to sign in via it.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    const providerId = provider?.id as string | undefined
    if (!providerId) {
      setError('Could not find the provider to delete — refresh and try again.')
      return
    }
    try {
      await deleteOAuthProvider(providerId)
      const c = await getSystemConfig()
      setCfg(c)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete provider')
    }
  }

  const handleEditProvider = (index: number) => {
    const p = cfg?.oauth_providers?.[index] as Record<string, unknown> | undefined
    if (!p) return
    setProviderError('')
    setEditingProviderIndex(index)
    setEditingProvider({
      provider: (p.provider as string) || 'oauth',
      display_name: (p.display_name as string) || '',
      client_id: (p.client_id as string) || '',
      client_secret: '***',
      redirect_uri: (p.redirect_uri as string) || '',
      tenant_id: (p.tenant_id as string) || '',
      idp_entity_id: (p.idp_entity_id as string) || '',
      idp_sso_url: (p.idp_sso_url as string) || '',
      idp_x509_cert: (p.idp_x509_cert as string) || '',
    })
    setShowAddProvider(false)
  }

  const handleUpdateProvider = async () => {
    if (editingProviderIndex === null) return
    const validationError = providerValidationError(editingProvider)
    if (validationError) { setProviderError(validationError); return }
    const providerId = (cfg?.oauth_providers?.[editingProviderIndex] as Record<string, unknown> | undefined)?.id as string | undefined
    if (!providerId) {
      setProviderError('Could not find the provider to update — refresh and try again.')
      return
    }
    setProviderError('')
    try {
      await updateOAuthProvider(providerId, editingProvider as unknown as Record<string, string>)
      const c = await getSystemConfig()
      setCfg(c)
      setEditingProviderIndex(null)
    } catch (e) {
      setProviderError(e instanceof Error ? e.message : 'Failed to update provider')
    }
  }

  const saveSupportContacts = async (contacts: typeof supportContacts) => {
    try {
      await updateSystemConfig({ support_contacts: contacts } as Record<string, unknown>)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save support contacts')
    }
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#6b7280' }}>Loading config...</div>

  // Structural guard: without this, a failed load left `cfg` null but still
  // rendered the form against pristine useState defaults, and Save would
  // write those defaults over real stored config (wiping the OCR API key,
  // resetting extraction_config/quality_config). Never remove this without
  // an equivalent guard in its place.
  if (!cfg || loadError) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div style={{
          display: 'inline-block', padding: '16px 20px', background: '#fef2f2', border: '1px solid #fecaca',
          borderRadius: 'var(--ui-radius, 12px)', color: '#991b1b', fontSize: 14, maxWidth: 480,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Could not load configuration</div>
          <div style={{ marginBottom: 12 }}>
            {loadError || 'The configuration failed to load.'} Saving is disabled until it loads
            successfully, so this cannot overwrite stored settings with blank defaults.
          </div>
          <button
            onClick={() => void loadConfig()}
            style={{
              padding: '6px 16px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #991b1b',
              fontSize: 13, fontWeight: 600, cursor: 'pointer', background: '#fff', color: '#991b1b',
            }}
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Sticky save bar */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 20,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        background: '#fff', borderBottom: '1px solid #e5e7eb',
        padding: '12px 20px', margin: '0 0 -4px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
      }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: '#374151', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Settings size={16} color="#6b7280" /> System Configuration
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {saved && <span role="status" aria-live="polite" style={{ fontSize: 13, color: '#16a34a' }}>Configuration saved!</span>}
          <button
            onClick={handleSaveConfig}
            disabled={saving}
            style={{
              padding: '8px 20px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
              backgroundColor: '#111827', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
              opacity: saving ? 0.6 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save Configuration'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: '10px 16px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--ui-radius, 12px)', color: '#991b1b', fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* Setup readiness — auto-shows while a blocker is unresolved; once the
          system is ready it can be dismissed for the session. */}
      {readiness && !(readiness.ready && setupDismissed) && (
        <SetupChecklist
          report={readiness}
          onJump={(target) => {
            const id = `cfg-${target}`
            document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            // First-run: if the admin is being sent to connect their first model,
            // drop them straight into the guided wizard instead of leaving them to
            // find the "Add Model" button. The panel itself decides whether to —
            // only when none exists and the form isn't already open.
            if (target === 'models') {
              modelEditorRef.current?.openFirstRunWizard()
            }
          }}
          onDismiss={readiness.ready ? () => setSetupDismissed(true) : undefined}
        />
      )}

      <ModelEditor
        ref={modelEditorRef}
        models={cfg.available_models}
        defaultModel={cfg.default_model}
        onConfigPatch={applyModelConfigPatch}
        onReadinessChange={refreshReadiness}
        error={error}
        onError={setError}
      />

      {/* Prompt Playground */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Play size={18} color="#6b7280" /> Prompt Playground
          <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280' }}>
            — send a prompt to a configured model and see the raw round-trip
          </span>
        </div>
        <div style={sectionBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 16, alignItems: 'start' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label htmlFor="admin-playground-system" style={labelStyle}>System Prompt (optional)</label>
                <textarea
                  id="admin-playground-system"
                  value={playgroundSystem}
                  onChange={e => setPlaygroundSystem(e.target.value)}
                  placeholder="e.g. You are a helpful assistant. Reply concisely."
                  rows={3}
                  style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: 13, resize: 'vertical' }}
                />
              </div>
              <div>
                <label htmlFor="admin-playground-user" style={labelStyle}>User Prompt</label>
                <textarea
                  id="admin-playground-user"
                  value={playgroundUser}
                  onChange={e => setPlaygroundUser(e.target.value)}
                  placeholder="Ask anything. The text below will be sent verbatim to the selected model."
                  rows={5}
                  style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', fontSize: 13, resize: 'vertical' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <label htmlFor="admin-playground-model" style={labelStyle}>Model</label>
                <select
                  id="admin-playground-model"
                  value={playgroundModel}
                  onChange={e => setPlaygroundModel(e.target.value)}
                  style={inputStyle}
                >
                  <option value="">
                    {cfg?.default_model ? `Default (${cfg.default_model})` : 'Default'}
                  </option>
                  {cfg?.available_models?.map((m, i) => (
                    <option key={i} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              <button
                onClick={handleSendPlaygroundPrompt}
                disabled={playgroundSending || !playgroundUser.trim()}
                style={{
                  padding: '10px 16px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                  backgroundColor: '#111827', color: '#fff', fontSize: 13, fontWeight: 600,
                  cursor: playgroundSending || !playgroundUser.trim() ? 'not-allowed' : 'pointer',
                  opacity: playgroundSending || !playgroundUser.trim() ? 0.6 : 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <Play size={14} /> {playgroundSending ? 'Sending...' : 'Send'}
              </button>
              {playgroundResult && (
                <div role="status" aria-live="polite" style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.6 }}>
                  <div>Model: <span style={{ color: '#111', fontFamily: 'ui-monospace, monospace' }}>{playgroundResult.request.model}</span></div>
                  <div>Latency: {playgroundResult.latency_ms} ms</div>
                  {playgroundResult.tokens && (
                    <div>
                      Tokens: {playgroundResult.tokens.request ?? '?'} in / {playgroundResult.tokens.response ?? '?'} out
                      {playgroundResult.tokens.total != null && ` / ${playgroundResult.tokens.total} total`}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {playgroundError && (
            <div role="alert" style={{ marginTop: 16, padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--ui-radius, 12px)', color: '#991b1b', fontSize: 13 }}>
              {playgroundError}
            </div>
          )}

          {playgroundResult && (
            <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  Request sent
                </div>
                <pre style={{
                  margin: 0, padding: 12, background: '#f9fafb', border: '1px solid #e5e7eb',
                  borderRadius: 'var(--ui-radius, 12px)', fontSize: 12, lineHeight: 1.5,
                  fontFamily: 'ui-monospace, monospace', color: '#111',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflow: 'auto',
                }}>
{`[system]
${playgroundResult.request.system_prompt || '(none)'}

[user]
${playgroundResult.request.user_prompt}`}
                </pre>
              </div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {playgroundResult.ok ? (
                    <><CheckCircle2 size={13} color="#059669" aria-hidden="true" /> Response</>
                  ) : (
                    <><XCircle size={13} color="#dc2626" aria-hidden="true" /> Error</>
                  )}
                </div>
                <pre style={{
                  margin: 0, padding: 12,
                  background: playgroundResult.ok ? '#f9fafb' : '#fef2f2',
                  border: `1px solid ${playgroundResult.ok ? '#e5e7eb' : '#fecaca'}`,
                  borderRadius: 'var(--ui-radius, 12px)', fontSize: 12, lineHeight: 1.5,
                  fontFamily: 'ui-monospace, monospace',
                  color: playgroundResult.ok ? '#111' : '#991b1b',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 400, overflow: 'auto',
                }}>
                  {playgroundResult.ok ? (playgroundResult.response_text || '(empty response)') : (playgroundResult.error || 'Unknown error')}
                </pre>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Authentication */}
      <div id="cfg-auth" style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Lock size={18} color="#6b7280" /> Authentication
        </div>
        <div style={sectionBodyStyle}>
          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>Auth Methods</label>
            <div style={{ display: 'flex', gap: 16 }}>
              {['password', 'oauth'].map(m => {
                // Disable unchecking the last remaining method — an empty
                // auth_methods list disables every login path with no
                // in-app recovery. The server also rejects this, but the
                // UI should never let an admin walk into that footgun.
                const isLastMethod = authMethods.length === 1 && authMethods.includes(m)
                return (
                  <label
                    key={m}
                    style={{ display: 'flex', alignItems: 'center', fontSize: 14, cursor: isLastMethod ? 'not-allowed' : 'pointer', textTransform: 'capitalize' }}
                  >
                    <input
                      type="checkbox"
                      checked={authMethods.includes(m)}
                      disabled={isLastMethod}
                      title={isLastMethod ? 'At least one auth method must remain enabled' : undefined}
                      onChange={e => {
                        if (e.target.checked) setAuthMethods(prev => [...prev, m])
                        else setAuthMethods(prev => prev.filter(x => x !== m))
                      }}
                      style={checkStyle}
                    />
                    {m === 'oauth' ? 'OAuth / SAML' : m}
                  </label>
                )
              })}
            </div>
            <button
              onClick={handleSaveAuthMethods}
              disabled={authSaving}
              style={{
                marginTop: 12, padding: '6px 16px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
                fontSize: 13, fontWeight: 500, cursor: 'pointer', background: '#fff',
              }}
            >
              {authSaving ? 'Saving...' : 'Update Methods'}
            </button>
          </div>

          {/* OAuth Providers */}
          <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <label style={{ ...labelStyle, marginBottom: 0 }}>OAuth / SAML Providers</label>
              <button
                onClick={() => setShowAddProvider(!showAddProvider)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px',
                  borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
                  fontSize: 13, fontWeight: 500, cursor: 'pointer', background: '#fff',
                }}
              >
                <Plus size={14} /> Add Provider
              </button>
            </div>

            {cfg?.oauth_providers && cfg.oauth_providers.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {cfg.oauth_providers.map((p, i) => (
                  <div key={i}>
                    <div style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '10px 16px', background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)',
                      border: '1px solid #e5e7eb',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <Globe size={16} color="#6b7280" />
                        <span style={{ fontSize: 14, fontWeight: 500 }}>{(p as Record<string, unknown>).display_name as string || (p as Record<string, unknown>).provider as string}</span>
                        <span style={{
                          fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#dbeafe', color: '#1e40af', fontWeight: 600,
                        }}>
                          {((p as Record<string, unknown>).provider as string || 'oauth').toUpperCase()}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button
                          type="button"
                          aria-label="Edit provider"
                          onClick={() => editingProviderIndex === i ? setEditingProviderIndex(null) : handleEditProvider(i)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}
                        >
                          <Pencil size={16} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          aria-label="Delete provider"
                          onClick={() => handleDeleteProvider(i)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {editingProviderIndex === i && (
                      <div style={{ marginTop: 8, padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #e5e7eb' }}>
                        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Edit Provider</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                          <div>
                            <label htmlFor={`admin-oauth-edit-${i}-type`} style={labelStyle}>Type</label>
                            <select
                              id={`admin-oauth-edit-${i}-type`}
                              value={editingProvider.provider}
                              onChange={e => setEditingProvider({ ...editingProvider, provider: e.target.value })}
                              style={inputStyle}
                            >
                              <option value="oauth">OAuth 2.0</option>
                              <option value="azure">Azure AD</option>
                              <option value="saml">SAML</option>
                            </select>
                          </div>
                          <div>
                            <label htmlFor={`admin-oauth-edit-${i}-display-name`} style={labelStyle}>Display Name</label>
                            <input id={`admin-oauth-edit-${i}-display-name`} value={editingProvider.display_name} onChange={e => setEditingProvider({ ...editingProvider, display_name: e.target.value })} style={inputStyle} />
                          </div>
                          {editingProvider.provider !== 'saml' && (
                            <>
                              <div>
                                <label htmlFor={`admin-oauth-edit-${i}-client-id`} style={labelStyle}>Client ID</label>
                                <input id={`admin-oauth-edit-${i}-client-id`} value={editingProvider.client_id} onChange={e => setEditingProvider({ ...editingProvider, client_id: e.target.value })} style={inputStyle} />
                              </div>
                              <div>
                                <label htmlFor={`admin-oauth-edit-${i}-client-secret`} style={labelStyle}>Client Secret</label>
                                <input id={`admin-oauth-edit-${i}-client-secret`} type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore name="vandalizer-oauth-client-secret-edit" value={editingProvider.client_secret} onChange={e => setEditingProvider({ ...editingProvider, client_secret: e.target.value })} style={inputStyle} placeholder="Leave as *** to keep existing" />
                              </div>
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label htmlFor={`admin-oauth-edit-${i}-redirect-uri`} style={labelStyle}>Redirect URI</label>
                                <input id={`admin-oauth-edit-${i}-redirect-uri`} value={editingProvider.redirect_uri} onChange={e => setEditingProvider({ ...editingProvider, redirect_uri: e.target.value })} style={inputStyle} />
                              </div>
                            </>
                          )}
                          {editingProvider.provider === 'azure' && (
                            <div style={{ gridColumn: '1 / -1' }}>
                              <label htmlFor={`admin-oauth-edit-${i}-tenant-id`} style={labelStyle}>Tenant ID</label>
                              <input id={`admin-oauth-edit-${i}-tenant-id`} value={editingProvider.tenant_id} onChange={e => setEditingProvider({ ...editingProvider, tenant_id: e.target.value })} style={inputStyle} />
                            </div>
                          )}
                          {editingProvider.provider === 'saml' && (
                            <>
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label htmlFor={`admin-oauth-edit-${i}-idp-entity`} style={labelStyle}>IdP Entity ID</label>
                                <input id={`admin-oauth-edit-${i}-idp-entity`} value={editingProvider.idp_entity_id} onChange={e => setEditingProvider({ ...editingProvider, idp_entity_id: e.target.value })} style={inputStyle} />
                              </div>
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label htmlFor={`admin-oauth-edit-${i}-idp-sso`} style={labelStyle}>IdP SSO URL</label>
                                <input id={`admin-oauth-edit-${i}-idp-sso`} value={editingProvider.idp_sso_url} onChange={e => setEditingProvider({ ...editingProvider, idp_sso_url: e.target.value })} style={inputStyle} />
                              </div>
                              <div style={{ gridColumn: '1 / -1' }}>
                                <label htmlFor={`admin-oauth-edit-${i}-idp-cert`} style={labelStyle}>IdP x509 Certificate</label>
                                <textarea id={`admin-oauth-edit-${i}-idp-cert`} value={editingProvider.idp_x509_cert} onChange={e => setEditingProvider({ ...editingProvider, idp_x509_cert: e.target.value })} style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace', fontSize: 11 }} />
                              </div>
                            </>
                          )}
                        </div>
                        {providerError && (
                          <div role="alert" style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--ui-radius, 12px)', color: '#b91c1c', fontSize: 13 }}>
                            {providerError}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button
                            onClick={handleUpdateProvider}
                            style={{
                              padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                              background: 'var(--highlight-color, #eab308)', color: 'var(--highlight-text-color, #000)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                            }}
                          >
                            Save Changes
                          </button>
                          <button
                            onClick={() => setEditingProviderIndex(null)}
                            style={{
                              padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
                              background: '#fff', fontSize: 13, cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '8px 0' }}>No providers configured.</div>
            )}

            {showAddProvider && (
              <div style={{ marginTop: 12, padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #e5e7eb' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>New Provider</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Type</label>
                    <select
                      value={newProvider.provider}
                      onChange={e => setNewProvider({ ...newProvider, provider: e.target.value })}
                      style={inputStyle}
                    >
                      <option value="oauth">OAuth 2.0</option>
                      <option value="azure">Azure AD</option>
                      <option value="saml">SAML</option>
                    </select>
                  </div>
                  <div>
                    <label style={labelStyle}>Display Name</label>
                    <input value={newProvider.display_name} onChange={e => setNewProvider({ ...newProvider, display_name: e.target.value })} style={inputStyle} />
                  </div>
                  {newProvider.provider !== 'saml' && (
                    <>
                      <div>
                        <label style={labelStyle}>Client ID</label>
                        <input value={newProvider.client_id} onChange={e => setNewProvider({ ...newProvider, client_id: e.target.value })} style={inputStyle} />
                      </div>
                      <div>
                        <label style={labelStyle}>Client Secret</label>
                        <input type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore name="vandalizer-oauth-client-secret-new" value={newProvider.client_secret} onChange={e => setNewProvider({ ...newProvider, client_secret: e.target.value })} style={inputStyle} />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>Redirect URI (set automatically; register this in your identity provider)</label>
                        <input value={`${window.location.origin}/api/auth/oauth/azure/callback`} readOnly style={{ ...inputStyle, opacity: 0.7, cursor: 'default' }} />
                      </div>
                    </>
                  )}
                  {newProvider.provider === 'azure' && (
                    <div style={{ gridColumn: '1 / -1' }}>
                      <label style={labelStyle}>Tenant ID</label>
                      <input value={newProvider.tenant_id} onChange={e => setNewProvider({ ...newProvider, tenant_id: e.target.value })} style={inputStyle} />
                    </div>
                  )}
                  {newProvider.provider === 'saml' && (
                    <>
                      <div style={{ gridColumn: '1 / -1', padding: 10, background: '#eef2ff', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #c7d2fe' }}>
                        <label style={labelStyle}>Import from IdP metadata (URL or paste XML) — auto-fills the fields below</label>
                        <textarea
                          value={samlMeta}
                          onChange={e => setSamlMeta(e.target.value)}
                          placeholder="https://idp.example.edu/idp/shibboleth  — or paste the metadata XML"
                          style={{ ...inputStyle, minHeight: 44 }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                          <button
                            type="button"
                            onClick={handleImportSamlMetadata}
                            disabled={samlMetaBusy || !samlMeta.trim()}
                            style={{ padding: '6px 12px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #6366f1', background: '#fff', color: '#4338ca', fontSize: 12, fontWeight: 600, cursor: samlMetaBusy || !samlMeta.trim() ? 'not-allowed' : 'pointer', opacity: samlMetaBusy || !samlMeta.trim() ? 0.6 : 1 }}
                          >
                            {samlMetaBusy ? 'Reading…' : 'Fetch & fill'}
                          </button>
                          {samlMetaError && <span role="alert" style={{ fontSize: 12, color: '#b91c1c' }}>{samlMetaError}</span>}
                        </div>
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>IdP Entity ID</label>
                        <input value={newProvider.idp_entity_id} onChange={e => setNewProvider({ ...newProvider, idp_entity_id: e.target.value })} style={inputStyle} placeholder="https://idp.example.edu/idp/shibboleth" />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>IdP SSO URL</label>
                        <input value={newProvider.idp_sso_url} onChange={e => setNewProvider({ ...newProvider, idp_sso_url: e.target.value })} style={inputStyle} placeholder="https://idp.example.edu/idp/profile/SAML2/Redirect/SSO" />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>IdP x509 Certificate</label>
                        <textarea value={newProvider.idp_x509_cert} onChange={e => setNewProvider({ ...newProvider, idp_x509_cert: e.target.value })} style={{ ...inputStyle, minHeight: 90, fontFamily: 'monospace', fontSize: 11 }} placeholder="-----BEGIN CERTIFICATE-----" />
                      </div>
                      <div style={{ gridColumn: '1 / -1' }}>
                        <label style={labelStyle}>Service Provider details (give these to your IdP administrator)</label>
                        <input value={`${window.location.origin}/api/auth/saml/metadata`} readOnly style={{ ...inputStyle, opacity: 0.7, cursor: 'default' }} />
                        <input value={`${window.location.origin}/api/auth/saml/acs`} readOnly style={{ ...inputStyle, opacity: 0.7, cursor: 'default', marginTop: 6 }} />
                      </div>
                    </>
                  )}
                </div>
                {providerError && (
                  <div role="alert" style={{ marginTop: 10, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--ui-radius, 12px)', color: '#b91c1c', fontSize: 13 }}>
                    {providerError}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    onClick={handleAddProvider}
                    style={{
                      padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                      background: 'var(--highlight-color, #eab308)', color: 'var(--highlight-text-color, #000)', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    }}
                  >
                    Add Provider
                  </button>
                  <button
                    onClick={() => setShowAddProvider(false)}
                    style={{
                      padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
                      background: '#fff', fontSize: 13, cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Endpoints */}
      <div id="cfg-ocr" style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Globe size={18} color="#6b7280" /> Endpoints
        </div>
        <div style={sectionBodyStyle}>
          <div>
            <label style={labelStyle}>OCR Endpoint</label>
            <input
              type="url" value={ocrEndpoint} onChange={e => setOcrEndpoint(e.target.value)}
              placeholder="https://..." style={{ ...inputStyle, maxWidth: 500 }}
            />
          </div>
          <div style={{ marginTop: 12 }}>
            <label style={labelStyle}>OCR API Key (optional)</label>
            <input
              type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore
              name="vandalizer-ocr-api-key"
              value={ocrApiKey} onChange={e => { setOcrApiKey(e.target.value); setOcrApiKeyDirty(true) }}
              placeholder="Bearer token..." style={{ ...inputStyle, maxWidth: 500 }}
            />
          </div>
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 12 }}>
            <button
              onClick={handleTestOcr}
              disabled={ocrTesting || !ocrEndpoint}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px',
                fontSize: 13, fontWeight: 500, borderRadius: 'var(--ui-radius, 12px)',
                border: '1px solid #e5e7eb', background: '#fff', cursor: ocrEndpoint ? 'pointer' : 'not-allowed',
                color: '#374151', opacity: ocrTesting ? 0.6 : 1,
              }}
            >
              <Play size={14} /> {ocrTesting ? 'Testing...' : 'Test Connection'}
            </button>
            {ocrTestResult && (
              <span role="status" aria-live="polite" style={{ fontSize: 13, color: ocrTestResult.ok ? '#059669' : '#dc2626', fontWeight: 500 }}>
                {ocrTestResult.ok ? <CheckCircle2 size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 4 }} /> : <XCircle size={14} aria-hidden="true" style={{ verticalAlign: -2, marginRight: 4 }} />}
                {ocrTestResult.message}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* UI Theme */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Palette size={18} color="#6b7280" /> UI Theme &amp; Branding
        </div>
        <div style={sectionBodyStyle}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
            <div>
              <label style={labelStyle}>Highlight Color</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input type="color" value={themeColor} onChange={e => setThemeColor(e.target.value)} style={{ height: 40, width: 56, borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db', cursor: 'pointer' }} />
                <input type="text" value={themeColor} onChange={e => setThemeColor(e.target.value)} style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }} />
              </div>
            </div>
            <div>
              <label style={labelStyle}>Corner Radius: {themeRadius}px</label>
              <input type="range" min={0} max={24} value={themeRadius} onChange={e => setThemeRadius(Number(e.target.value))} style={{ width: '100%', marginTop: 8, accentColor: 'var(--highlight-color, #eab308)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                <span>0px (sharp)</span>
                <span>24px (round)</span>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20 }}>
            <div>
              <label style={labelStyle}>Organization Name</label>
              <input
                type="text"
                value={themeOrgName}
                onChange={e => setThemeOrgName(e.target.value)}
                placeholder={DEFAULT_ORG_NAME}
                style={inputStyle}
              />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Shown in the header, login page, browser tab, and chat greeting. Leave blank to keep "Vandalizer".
              </div>
            </div>
            <div>
              <label style={labelStyle}>Logo</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 180, height: 56, borderRadius: 'var(--ui-radius, 12px)',
                  border: '1px solid #e5e7eb', background: '#f9fafb',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}>
                  {themeLogo ? (
                    <img src={themeLogo} alt="Logo preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  ) : (
                    <img src="/images/Vandalizer_Wordmark_RGB.png" alt="Default Vandalizer logo" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', opacity: 0.7 }} />
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{
                    padding: '6px 12px', borderRadius: 'var(--ui-radius, 12px)',
                    border: '1px solid #d1d5db', background: '#fff',
                    fontSize: 12, fontWeight: 500, cursor: 'pointer', textAlign: 'center',
                  }}>
                    {themeLogo ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      onChange={e => handleLogoFile(e.target.files?.[0] || null)}
                      style={{ display: 'none' }}
                    />
                  </label>
                  {themeLogo && (
                    <button
                      type="button"
                      onClick={() => { setThemeLogo(''); setThemeLogoError(null) }}
                      style={{
                        padding: '6px 12px', borderRadius: 'var(--ui-radius, 12px)',
                        border: '1px solid #fee2e2', background: '#fff',
                        color: '#b91c1c', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      }}
                    >
                      Use default
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Wordmark-style image works best. PNG with transparency recommended. Large images are automatically resized to fit.
              </div>
              {themeLogoError && (
                <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 6 }}>{themeLogoError}</div>
              )}
            </div>
            <div>
              <label style={labelStyle}>Icon / Mascot</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 56, height: 56, borderRadius: 'var(--ui-radius, 12px)',
                  border: '1px solid #e5e7eb', background: '#f9fafb',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                }}>
                  {themeIcon ? (
                    <img src={themeIcon} alt="Icon preview" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
                  ) : (
                    <img src={DEFAULT_ICON_URL} alt="Default Joe Vandal icon" style={{ maxWidth: '70%', maxHeight: '90%', objectFit: 'contain', opacity: 0.7 }} />
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label style={{
                    padding: '6px 12px', borderRadius: 'var(--ui-radius, 12px)',
                    border: '1px solid #d1d5db', background: '#fff',
                    fontSize: 12, fontWeight: 500, cursor: 'pointer', textAlign: 'center',
                  }}>
                    {themeIcon ? 'Replace' : 'Upload'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/svg+xml,image/webp"
                      onChange={e => handleIconFile(e.target.files?.[0] || null)}
                      style={{ display: 'none' }}
                    />
                  </label>
                  {themeIcon && (
                    <button
                      type="button"
                      onClick={() => { setThemeIcon(''); setThemeIconError(null) }}
                      style={{
                        padding: '6px 12px', borderRadius: 'var(--ui-radius, 12px)',
                        border: '1px solid #fee2e2', background: '#fff',
                        color: '#b91c1c', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Small square mark shown beside the logo (header & chat) and as the browser-tab favicon. A square, transparent PNG works best. The default Joe Vandal mark shows only on un-branded deployments — once you set an organization name or logo, leave this blank to hide it, or upload your own.
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', marginTop: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={themeIconHideInNav}
                  onChange={e => setThemeIconHideInNav(e.target.checked)}
                />
                Hide icon from the navigation header (still used as favicon and chat avatar)
              </label>
              {themeIconError && (
                <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 6 }}>{themeIconError}</div>
              )}
            </div>
          </div>

          <div style={{
            marginTop: 16, padding: 12, background: '#f9fafb',
            borderRadius: 'var(--ui-radius, 12px)', border: '1px dashed #e5e7eb',
            fontSize: 12, color: '#6b7280', lineHeight: 1.5,
          }}>
            Vandalizer is open source under the GPL v3 license and developed at the University of Idaho with support from the NSF GRANTED program (Award #2427549). Even with your custom branding applied, the footer will continue to credit the Vandalizer project and acknowledge NSF funding.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <div style={{ backgroundColor: themeColor, borderRadius: `${themeRadius}px`, padding: '8px 20px', color: 'var(--highlight-text-color, #000)', fontWeight: 600, fontSize: 13 }}>
              Sample Button
            </div>
            <div style={{ border: `2px solid ${themeColor}`, borderRadius: `${themeRadius}px`, padding: '8px 20px', color: themeColor, fontWeight: 600, fontSize: 13 }}>
              Outline Button
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button
              onClick={handleSaveTheme}
              disabled={themeSaving}
              style={{
                padding: '8px 20px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                background: '#111827', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: themeSaving ? 0.6 : 1,
              }}
            >
              {themeSaving ? 'Saving...' : 'Save Theme'}
            </button>
            {themeSaved && <span role="status" aria-live="polite" style={{ fontSize: 13, color: '#16a34a' }}>Theme saved!</span>}
          </div>
        </div>
      </div>

      {/* Extraction Configuration */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Cpu size={18} color="#6b7280" /> Extraction Configuration
        </div>
        <div style={sectionBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Mode */}
            <div>
              <label style={labelStyle}>Extraction Mode</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['one_pass', 'two_pass'].map(mode => (
                  <button
                    key={mode}
                    onClick={() => setExtractionMode(mode)}
                    style={{
                      padding: '8px 20px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
                      fontSize: 13, fontWeight: 500, cursor: 'pointer', textTransform: 'capitalize',
                      backgroundColor: extractionMode === mode ? 'var(--highlight-color, #eab308)' : '#fff',
                      color: extractionMode === mode ? 'var(--highlight-text-color, #000)' : '#374151',
                    }}
                  >
                    {mode.replace('_', '-')}
                  </button>
                ))}
              </div>
            </div>

            {/* Mode-specific options */}
            {extractionMode === 'one_pass' ? (
              <div style={{ padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>One-Pass Settings</div>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={onePassThinking} onChange={e => setOnePassThinking(e.target.checked)} style={checkStyle} />
                  Thinking
                </label>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 12, cursor: 'pointer' }}>
                  <input type="checkbox" checked={onePassStructured} onChange={e => setOnePassStructured(e.target.checked)} style={checkStyle} />
                  Structured
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 13, color: '#5f6368' }}>Model:</label>
                  <select value={onePassModel} onChange={e => setOnePassModel(e.target.value)} style={{ ...inputStyle, maxWidth: 260 }}>
                    <option value="">Default</option>
                    {cfg?.available_models?.map(m => (
                      <option key={m.tag} value={m.name}>{m.tag || m.name}</option>
                    ))}
                  </select>
                </div>
              </div>
            ) : (
              <div style={{ padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Two-Pass Settings</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Pass 1 (Draft)</div>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={twoPassP1Thinking} onChange={e => setTwoPassP1Thinking(e.target.checked)} style={checkStyle} />
                      Thinking
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={twoPassP1Structured} onChange={e => setTwoPassP1Structured(e.target.checked)} style={checkStyle} />
                      Structured
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 13, color: '#5f6368' }}>Model:</label>
                      <select value={twoPassP1Model} onChange={e => setTwoPassP1Model(e.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
                        <option value="">Default</option>
                        {cfg?.available_models?.map(m => (
                          <option key={m.tag} value={m.name}>{m.tag || m.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#6b7280', marginBottom: 8 }}>Pass 2 (Final)</div>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 8, cursor: 'pointer' }}>
                      <input type="checkbox" checked={twoPassP2Thinking} onChange={e => setTwoPassP2Thinking(e.target.checked)} style={checkStyle} />
                      Thinking
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, marginBottom: 12, cursor: 'pointer' }}>
                      <input type="checkbox" checked={twoPassP2Structured} onChange={e => setTwoPassP2Structured(e.target.checked)} style={checkStyle} />
                      Structured
                    </label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 13, color: '#5f6368' }}>Model:</label>
                      <select value={twoPassP2Model} onChange={e => setTwoPassP2Model(e.target.value)} style={{ ...inputStyle, maxWidth: 200 }}>
                        <option value="">Default</option>
                        {cfg?.available_models?.map(m => (
                          <option key={m.tag} value={m.name}>{m.tag || m.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Chunking */}
            <div>
              <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                <input type="checkbox" checked={chunkingEnabled} onChange={e => setChunkingEnabled(e.target.checked)} style={checkStyle} />
                Enable Chunking
              </label>
              {chunkingEnabled && (
                <div style={{ marginTop: 12, paddingLeft: 24 }}>
                  <label style={labelStyle}>Max Keys Per Chunk</label>
                  <input
                    type="number" min={1} max={100} value={maxKeysPerChunk}
                    onChange={e => setMaxKeysPerChunk(Number(e.target.value))}
                    style={{ ...inputStyle, maxWidth: 120 }}
                  />
                </div>
              )}
            </div>

            {/* Repetition */}
            <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={repetitionEnabled} onChange={e => setRepetitionEnabled(e.target.checked)} style={checkStyle} />
              Enable Repetition/Consensus
            </label>

            {/* Use Images (multimodal) — only shown when multimodal models exist */}
            {cfg?.available_models?.some(m => m.multimodal) && (
              <div>
                <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
                  <input type="checkbox" checked={useImages} onChange={e => setUseImages(e.target.checked)} style={checkStyle} />
                  Use Document Images (Multimodal)
                </label>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4, paddingLeft: 24 }}>
                  Send document files directly to multimodal LLMs instead of OCR text. Requires a multimodal model to be selected for extraction.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quality & Verification Gates */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <ShieldCheck size={18} color="#6b7280" /> Quality &amp; Verification Gates
        </div>
        <div style={sectionBodyStyle}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label style={{ display: 'flex', alignItems: 'center', fontSize: 14, fontWeight: 500, cursor: 'pointer' }}>
              <input type="checkbox" checked={requireValidation} onChange={e => setRequireValidation(e.target.checked)} style={checkStyle} />
              Require validation before verification submission
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              <div>
                <label style={labelStyle}>Min Extraction Accuracy (%)</label>
                <input type="number" min={0} max={100} value={minAccuracy} onChange={e => setMinAccuracy(Number(e.target.value))} style={{ ...inputStyle, maxWidth: 120 }} />
              </div>
              <div>
                <label style={labelStyle}>Min Extraction Consistency (%)</label>
                <input type="number" min={0} max={100} value={minConsistency} onChange={e => setMinConsistency(Number(e.target.value))} style={{ ...inputStyle, maxWidth: 120 }} />
              </div>
              <div>
                <label style={labelStyle}>Min Workflow Grade</label>
                <select value={minWorkflowGrade} onChange={e => setMinWorkflowGrade(e.target.value)} style={{ ...inputStyle, maxWidth: 120 }}>
                  <option value="A">A</option>
                  <option value="B">B</option>
                  <option value="C">C</option>
                  <option value="D">D</option>
                  <option value="F">F</option>
                </select>
              </div>
            </div>

            <div style={{ borderTop: '1px solid #e5e7eb', paddingTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Quality Tiers</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
                <div>
                  <label style={labelStyle}>Excellent threshold</label>
                  <input type="number" min={0} max={100} value={excellentThreshold} onChange={e => setExcellentThreshold(Number(e.target.value))} style={{ ...inputStyle, maxWidth: 120 }} />
                </div>
                <div>
                  <label style={labelStyle}>Good threshold</label>
                  <input type="number" min={0} max={100} value={goodThreshold} onChange={e => setGoodThreshold(Number(e.target.value))} style={{ ...inputStyle, maxWidth: 120 }} />
                </div>
                <div>
                  <label style={labelStyle}>Fair threshold</label>
                  <input type="number" min={0} max={100} value={fairThreshold} onChange={e => setFairThreshold(Number(e.target.value))} style={{ ...inputStyle, maxWidth: 120 }} />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Support Contacts */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Users size={18} color="#6b7280" /> Support Contacts
          <div style={{ flex: 1 }} />
          <button
            onClick={() => { setNewContact({ user_id: '', email: '', name: '' }); setShowAddContact(true) }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px',
              borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
              fontSize: 13, fontWeight: 500, cursor: 'pointer', background: '#fff',
            }}
          >
            <Plus size={14} /> Add Contact
          </button>
        </div>
        <div style={sectionBodyStyle}>
          <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
            People listed here will receive email alerts and in-app notifications when new support tickets are created. They will also have access to the Support Center to manage all tickets.
          </p>
          {supportContacts.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {supportContacts.map((c, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px', background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)',
                  border: '1px solid #e5e7eb',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{c.name}</span>
                    <span style={{ fontSize: 13, color: '#6b7280' }}>{c.email}</span>
                    <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#f3f4f6', color: '#6b7280', fontWeight: 600 }}>{c.user_id}</span>
                  </div>
                  <button
                    onClick={() => {
                      const updated = supportContacts.filter((_, idx) => idx !== i)
                      setSupportContacts(updated)
                      saveSupportContacts(updated)
                    }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}
                    title="Remove contact"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#9ca3af' }}>No support contacts configured.</div>
          )}
          {showAddContact && (
            <div style={{ marginTop: 16, padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #e5e7eb' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12 }}>Add Support Contact</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Name</label>
                  <input value={newContact.name} onChange={e => setNewContact({ ...newContact, name: e.target.value })} placeholder="Jane Doe" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>User ID</label>
                  <input value={newContact.user_id} onChange={e => setNewContact({ ...newContact, user_id: e.target.value })} placeholder="jdoe" style={inputStyle} />
                </div>
                <div>
                  <label style={labelStyle}>Email</label>
                  <input value={newContact.email} onChange={e => setNewContact({ ...newContact, email: e.target.value })} placeholder="jdoe@example.com" style={inputStyle} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button
                  onClick={() => {
                    if (!newContact.name.trim() || !newContact.user_id.trim()) return
                    const updated = [...supportContacts, { ...newContact }]
                    setSupportContacts(updated)
                    saveSupportContacts(updated)
                    setShowAddContact(false)
                  }}
                  disabled={!newContact.name.trim() || !newContact.user_id.trim()}
                  style={{
                    padding: '6px 14px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                    background: '#111827', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    opacity: (!newContact.name.trim() || !newContact.user_id.trim()) ? 0.5 : 1,
                  }}
                >
                  Add
                </button>
                <button
                  onClick={() => setShowAddContact(false)}
                  style={{ padding: '6px 14px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db', background: '#fff', fontSize: 13, cursor: 'pointer' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Compliance Activation */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Lock size={18} color="#6b7280" /> Document Compliance Checks
        </div>
        <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
            When enabled, every uploaded document is scanned in chunks by an LLM
            against the policy below. Documents containing sensitive or policy-violating
            content are flagged in the document library.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input type="checkbox" checked={complianceEnabled} onChange={e => setComplianceEnabled(e.target.checked)} />
            <span style={{ fontSize: 14, fontWeight: 500 }}>Activate compliance checks</span>
          </label>
          {complianceEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={complianceCheckOnUpload}
                  onChange={e => setComplianceCheckOnUpload(e.target.checked)}
                />
                <span style={{ fontSize: 13 }}>Run checks automatically on every upload</span>
              </label>
              <div>
                <label style={labelStyle}>Compliance policy (sent to the validator LLM)</label>
                <textarea
                  value={complianceRules}
                  onChange={e => setComplianceRules(e.target.value)}
                  placeholder="Describe what content should be flagged…"
                  rows={6}
                  style={{ ...inputStyle, fontFamily: 'inherit', resize: 'vertical' }}
                />
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                  Plain English. The validator decides whether each chunk passes or fails based on this rule set.
                </div>
              </div>
              <div style={{ display: 'flex', gap: 12 }}>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Chunk size (chars)</label>
                  <input
                    type="number"
                    min={500}
                    value={complianceChunkSize}
                    onChange={e => setComplianceChunkSize(Number(e.target.value) || 8000)}
                    style={inputStyle}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label style={labelStyle}>Chunk overlap (chars)</label>
                  <input
                    type="number"
                    min={0}
                    value={complianceChunkOverlap}
                    onChange={e => setComplianceChunkOverlap(Number(e.target.value) || 0)}
                    style={inputStyle}
                  />
                </div>
              </div>
            </div>
          )}
          <div>
            <button
              onClick={async () => {
                setComplianceSaving(true)
                setComplianceSaved(false)
                try {
                  await updateCompliancePolicyConfig({
                    enabled: complianceEnabled,
                    check_on_upload: complianceCheckOnUpload,
                    rules: complianceRules,
                    chunk_size: complianceChunkSize,
                    chunk_overlap: complianceChunkOverlap,
                  })
                  setComplianceSaved(true)
                  setTimeout(() => setComplianceSaved(false), 3000)
                } catch {
                  setError('Failed to save compliance configuration')
                } finally {
                  setComplianceSaving(false)
                }
              }}
              disabled={complianceSaving}
              style={{
                padding: '8px 20px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                background: '#111827', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: complianceSaving ? 0.6 : 1,
              }}
            >
              {complianceSaving ? 'Saving...' : 'Save Compliance Settings'}
            </button>
            {complianceSaved && <span role="status" aria-live="polite" style={{ marginLeft: 10, fontSize: 13, color: '#16a34a' }}>Saved!</span>}
          </div>
        </div>
      </div>

      {/* Retention Policy */}
      <div style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <ShieldCheck size={18} color="#6b7280" /> Document Retention Policy
        </div>
        <div style={{ padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.5 }}>
            When enforcement is on, documents are auto-scheduled for soft-deletion after their
            classification-specific retention window. Soft-deleted documents become unrecoverable
            after the grace period expires. Items on retention hold are never auto-deleted.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={retentionEnabled}
              onChange={e => setRetentionEnabled(e.target.checked)}
              style={checkStyle}
            />
            <span style={{ fontSize: 14, fontWeight: 500 }}>Activate retention enforcement</span>
          </label>
          {retentionEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 0' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                  Per-classification rules
                </div>
                <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', color: '#6b7280', textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', fontWeight: 500 }}>Tier</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500 }}>Retention (days)</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500 }}>Grace before purge (days)</th>
                      <th style={{ padding: '8px 12px', fontWeight: 500 }}>Warn before (days)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { name: 'unrestricted', label: 'Unrestricted', color: '#22c55e' },
                      { name: 'internal', label: 'Internal', color: '#3b82f6' },
                      { name: 'ferpa', label: 'FERPA', color: '#f59e0b' },
                      { name: 'cui', label: 'CUI', color: '#f97316' },
                      { name: 'itar', label: 'ITAR', color: '#ef4444' },
                    ].map(level => {
                      const p = retentionPolicies[level.name] || { retention_days: 0, soft_delete_grace_days: 0 }
                      const update = (patch: Partial<RetentionPolicyForm>) => {
                        setRetentionPolicies(prev => ({
                          ...prev,
                          [level.name]: { ...p, ...patch },
                        }))
                      }
                      return (
                        <tr key={level.name} style={{ borderTop: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={{
                              display: 'inline-flex', alignItems: 'center', gap: 6,
                              padding: '2px 10px', borderRadius: 9999,
                              fontSize: 12, fontWeight: 600,
                              backgroundColor: `${level.color}1a`, color: level.color,
                              border: `1px solid ${level.color}66`,
                            }}>
                              <span style={{ width: 6, height: 6, borderRadius: 9999, backgroundColor: level.color }} />
                              {level.label}
                            </span>
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input
                              type="number"
                              min={0}
                              value={p.retention_days || 0}
                              onChange={e => update({ retention_days: Number(e.target.value) || 0 })}
                              style={{ ...inputStyle, padding: '6px 10px', width: 120 }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input
                              type="number"
                              min={0}
                              value={p.soft_delete_grace_days || 0}
                              onChange={e => update({ soft_delete_grace_days: Number(e.target.value) || 0 })}
                              style={{ ...inputStyle, padding: '6px 10px', width: 120 }}
                            />
                          </td>
                          <td style={{ padding: '8px 12px' }}>
                            <input
                              type="number"
                              min={0}
                              value={p.warning_days_before ?? ''}
                              placeholder="—"
                              aria-label="Retention period (days)"
                              onChange={e => {
                                const v = e.target.value
                                update({ warning_days_before: v === '' ? undefined : Number(v) || 0 })
                              }}
                              style={{ ...inputStyle, padding: '6px 10px', width: 120 }}
                            />
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                  Other retention windows
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Activity logs (days)</label>
                    <input
                      type="number"
                      min={0}
                      value={activityRetentionDays}
                      onChange={e => setActivityRetentionDays(Number(e.target.value) || 0)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Chat conversations (days)</label>
                    <input
                      type="number"
                      min={0}
                      value={chatRetentionDays}
                      onChange={e => setChatRetentionDays(Number(e.target.value) || 0)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Workflow results (days)</label>
                    <input
                      type="number"
                      min={0}
                      value={workflowResultRetentionDays}
                      onChange={e => setWorkflowResultRetentionDays(Number(e.target.value) || 0)}
                      style={inputStyle}
                    />
                  </div>
                  <div>
                    <label style={labelStyle}>Stale activity threshold (min)</label>
                    <input
                      type="number"
                      min={0}
                      value={staleActivityMinutes}
                      onChange={e => setStaleActivityMinutes(Number(e.target.value) || 0)}
                      style={inputStyle}
                    />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div>
            <button
              onClick={async () => {
                setRetentionSaving(true)
                setRetentionSaved(false)
                try {
                  await updateSystemConfig({
                    retention_config: {
                      enabled: retentionEnabled,
                      policies: retentionPolicies,
                      activity_retention_days: activityRetentionDays,
                      chat_retention_days: chatRetentionDays,
                      workflow_result_retention_days: workflowResultRetentionDays,
                      activity_stale_threshold_minutes: staleActivityMinutes,
                    },
                  })
                  setRetentionSaved(true)
                  setTimeout(() => setRetentionSaved(false), 3000)
                } catch {
                  setError('Failed to save retention configuration')
                } finally {
                  setRetentionSaving(false)
                }
              }}
              disabled={retentionSaving}
              style={{
                padding: '8px 20px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
                background: '#111827', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                opacity: retentionSaving ? 0.6 : 1,
              }}
            >
              {retentionSaving ? 'Saving...' : 'Save Retention Settings'}
            </button>
            {retentionSaved && <span role="status" aria-live="polite" style={{ marginLeft: 10, fontSize: 13, color: '#16a34a' }}>Saved!</span>}
          </div>
        </div>
      </div>

      {/* Save config button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          onClick={handleSaveConfig}
          disabled={saving}
          style={{
            padding: '10px 24px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
            backgroundColor: '#111827', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save Configuration'}
        </button>
        {saved && <span role="status" aria-live="polite" style={{ fontSize: 13, color: '#16a34a' }}>Configuration saved!</span>}
      </div>
    </div>
  )
}
