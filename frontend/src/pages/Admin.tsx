import React, { useEffect, useState, useCallback } from 'react'
import {
  Shield, ShieldCheck, BarChart3, Users, Building2, Workflow, Settings,
  Palette, Cpu, Lock, Globe, Plus, Trash2, Pencil,
  RefreshCw, Zap,
  CheckCircle2, XCircle,
  ChevronDown, ChevronUp, Play, AlertCircle,
  FileText, FolderTree, X,
  Mail, Star, Award, KeyRound, PackageOpen,
  BookOpen,
} from 'lucide-react'
import { PageLayout } from '../components/layout/PageLayout'
import { useConfirm } from '../components/shared/useConfirm'
import { useAuth } from '../hooks/useAuth'
import { useTeams } from '../hooks/useTeams'
import { getThemeConfig, updateThemeConfig } from '../api/config'
import type { ThemeConfig } from '../api/config'
import { useBranding, DEFAULT_ORG_NAME, DEFAULT_ICON_URL } from '../contexts/BrandingContext'
import {
  getSystemConfig, updateSystemConfig, updateCompliancePolicyConfig,
  addModel, updateModel, deleteModel, setDefaultModel, testOcr, testModel, testPrompt, probeModel, getReadiness, addOAuthProvider,
  updateOAuthProvider, deleteOAuthProvider, updateAuthMethods, parseSamlMetadata,
} from '../api/admin'
import type { TestPromptResult, ModelTestResult, ReadinessReport, ReadinessItem } from '../api/admin'
import type {
  SystemConfigData,
} from '../api/admin'
import { fileToConstrainedDataUrl } from '../utils/imageResize'
import { ModelCharacterBars } from '../components/ModelEffortPicker'
import type { ModelInfo } from '../types/workflow'
import { getAuthConfig } from '../api/auth'
import { UpdateBanner } from '../components/admin/UpdateBanner'
import { CatalogUpdateBanner } from '../components/admin/CatalogUpdateBanner'
import { CatalogTab } from '../components/admin/CatalogTab'
import { ApiKeysTab } from '../components/admin/ApiKeysTab'
import { ComplianceTab } from '../components/admin/ComplianceTab'
import { TeamsTab } from '../components/admin/TeamsTab'
import { KnowledgeBasesTab } from '../components/admin/KnowledgeBasesTab'
import { AuditTab } from '../components/admin/AuditTab'
import { UsersTab } from '../components/admin/UsersTab'
import { UsageTab } from '../components/admin/UsageTab'
import { WorkflowsTab } from '../components/admin/WorkflowsTab'
import { OrganizationsTab } from '../components/admin/OrganizationsTab'
import { QualityTab } from '../components/admin/QualityTab'
import { CertificationsTab } from '../components/admin/CertificationsTab'
import { EmailAnalyticsTab } from '../components/admin/EmailAnalyticsTab'
import { DemoTab } from '../components/admin/DemoTab'
import { TelemetryTab } from '../components/admin/TelemetryTab'
import { TelemetryOptInBanner } from '../components/admin/TelemetryOptInBanner'
import { getFeatureFlags } from '../api/config'

function applyThemeToDOM(theme: ThemeConfig) {
  const root = document.documentElement
  root.style.setProperty('--highlight-color', theme.highlight_color)
  root.style.setProperty('--ui-radius', theme.ui_radius)
}

const MAX_LOGO_BYTES = 500_000 // matches backend cap on the encoded data URL

type Tab = 'usage' | 'users' | 'teams' | 'organizations' | 'workflows' | 'quality' | 'knowledgebases' | 'compliance' | 'audit' | 'demo' | 'email' | 'certifications' | 'apikeys' | 'catalog' | 'telemetry' | 'config'

const TABS: { key: Tab; label: string; icon: typeof BarChart3 }[] = [
  { key: 'usage', label: 'Usage', icon: BarChart3 },
  { key: 'users', label: 'Users', icon: Users },
  { key: 'teams', label: 'Teams', icon: Building2 },
  { key: 'organizations', label: 'Organizations', icon: FolderTree },
  { key: 'workflows', label: 'Workflows', icon: Workflow },
  { key: 'quality', label: 'Quality', icon: ShieldCheck },
  { key: 'knowledgebases', label: 'Knowledge Bases', icon: BookOpen },
  { key: 'compliance', label: 'Compliance', icon: Lock },
  { key: 'audit', label: 'Audit Log', icon: FileText },
  { key: 'demo', label: 'Demo', icon: Zap },
  { key: 'email', label: 'Email', icon: Mail },
  { key: 'certifications', label: 'Certifications', icon: Award },
  { key: 'apikeys', label: 'API Keys', icon: KeyRound },
  { key: 'catalog', label: 'Catalog', icon: PackageOpen },
  { key: 'telemetry', label: 'Telemetry', icon: Globe },
  { key: 'config', label: 'Config', icon: Settings },
]

// ──────────────────────────────────────────
// Model connectivity diagnostics
// ──────────────────────────────────────────

// Renders the step-by-step result of a model "Test" — on success, why the
// hook-up is healthy (protocol, endpoint, latency, tokens, the actual reply);
// on failure, a classified error with a plain-English cause and suggested fix.
function ModelTestDiagnostics({ result }: { result: ModelTestResult }) {
  const [showRaw, setShowRaw] = useState(false)
  const accent = result.ok ? '#16a34a' : '#dc2626'
  return (
    <div style={{
      padding: '12px 16px', fontSize: 13,
      background: result.ok ? '#f0fdf4' : '#fef2f2',
      border: '1px solid', borderTop: 'none',
      borderColor: result.ok ? '#bbf7d0' : '#fecaca',
      borderRadius: '0 0 var(--ui-radius, 12px) var(--ui-radius, 12px)',
    }}>
      <div style={{ fontWeight: 600, color: result.ok ? '#166534' : '#991b1b', marginBottom: 10 }}>
        {result.summary}
      </div>

      {/* Step-by-step checks */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        {result.checks.map((c, idx) => (
          <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
            {c.ok
              ? <CheckCircle2 size={15} style={{ color: '#16a34a', flexShrink: 0, marginTop: 1 }} />
              : <XCircle size={15} style={{ color: '#dc2626', flexShrink: 0, marginTop: 1 }} />}
            <span style={{ color: '#374151' }}>
              <span style={{ fontWeight: 600 }}>{c.label}:</span> {c.detail}
            </span>
          </div>
        ))}
      </div>

      {/* Success facts */}
      {result.ok && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
          {result.protocol && <DiagFact label="Protocol" value={result.protocol} />}
          {result.endpoint && <DiagFact label="Endpoint" value={result.endpoint} mono />}
          {typeof result.latency_ms === 'number' && <DiagFact label="Latency" value={`${result.latency_ms} ms`} />}
          {result.tokens?.total != null && <DiagFact label="Tokens" value={String(result.tokens.total)} />}
        </div>
      )}
      {result.ok && result.response_preview && (
        <div style={{ marginTop: 10, padding: '8px 10px', background: '#fff', border: '1px solid #d1fae5', borderRadius: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12, color: '#374151' }}>
          <span style={{ color: '#9ca3af' }}>reply:</span> {result.response_preview}
        </div>
      )}

      {/* Failure guidance */}
      {!result.ok && result.error && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <AlertCircle size={15} style={{ color: accent, flexShrink: 0, marginTop: 1 }} />
            <div>
              <div style={{ fontWeight: 600, color: '#991b1b' }}>{result.error.title}</div>
              <div style={{ color: '#374151', marginTop: 2 }}>{result.error.why}</div>
            </div>
          </div>
          <div style={{ padding: '8px 10px', background: '#fff', border: '1px solid #fecaca', borderRadius: 8, color: '#374151' }}>
            <span style={{ fontWeight: 600, color: '#b91c1c' }}>Try this: </span>{result.error.fix}
          </div>
          {result.error.raw && (
            <div>
              <button
                onClick={() => setShowRaw(v => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', fontSize: 12, padding: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                {showRaw ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {showRaw ? 'Hide' : 'Show'} raw provider error
              </button>
              {showRaw && (
                <pre style={{ marginTop: 6, padding: '8px 10px', background: '#1f2937', color: '#f9fafb', borderRadius: 8, fontSize: 11, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {result.error.raw}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function DiagFact({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 9999, fontSize: 12 }}>
      <span style={{ color: '#9ca3af', fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#374151', fontFamily: mono ? 'ui-monospace, monospace' : undefined }}>{value}</span>
    </span>
  )
}

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

// The editable shape of a single LLM model config row.
type ModelDraft = {
  name: string
  tag: string
  external: boolean
  thinking: boolean
  endpoint: string
  api_protocol: string
  api_key: string
  speed: string
  tier: string
  privacy: string
  supports_structured: boolean
  multimodal: boolean
  supports_pdf: boolean
  context_window: number
  // Optional per-model overrides. 0 = unset (backend uses system default /
  // computed value).
  request_timeout_seconds: number
  response_reserve_tokens: number
}

const EMPTY_MODEL_DRAFT: ModelDraft = {
  name: '', tag: '', external: false, thinking: false, endpoint: '', api_protocol: '', api_key: '',
  speed: '', tier: '', privacy: '', supports_structured: true, multimodal: false, supports_pdf: false,
  context_window: 128000, request_timeout_seconds: 0, response_reserve_tokens: 0,
}

// Provider presets power the "Add a Model" wizard. Selecting one fills in the
// technical fields (protocol, endpoint, external/privacy flags, sensible
// capability defaults) so admins only supply a model name and, for hosted APIs,
// a key. `apply` is merged into the draft; everything stays editable under
// "Advanced settings".
type ModelProviderPreset = {
  id: string
  label: string
  blurb: string
  needsKey: boolean
  needsEndpoint: boolean
  keyPlaceholder?: string
  keyHelp?: string
  namePlaceholder: string
  nameSuggestions?: string[]
  endpointPlaceholder?: string
  apply: Partial<ModelDraft>
}

const MODEL_PROVIDERS: ModelProviderPreset[] = [
  {
    id: 'google',
    label: 'Google (Gemini)',
    blurb: "Gemini models via Google AI Studio. Native integration — just a model name and key.",
    needsKey: true,
    needsEndpoint: false,
    keyPlaceholder: 'AIza… (AI Studio API key)',
    keyHelp: 'Create a key at aistudio.google.com → API keys.',
    namePlaceholder: 'gemini-2.5-flash',
    nameSuggestions: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    apply: { api_protocol: 'google', external: true, privacy: 'external', endpoint: '', tag: 'google', multimodal: true, supports_pdf: true, context_window: 1048576 },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    blurb: 'GPT models from the OpenAI API.',
    needsKey: true,
    needsEndpoint: false,
    keyPlaceholder: 'sk-…',
    namePlaceholder: 'gpt-4o',
    nameSuggestions: ['gpt-4o', 'gpt-4o-mini'],
    apply: { api_protocol: 'openai', external: true, privacy: 'external', endpoint: 'https://api.openai.com/v1', tag: 'openai', multimodal: true },
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    blurb: 'Claude models via the native Anthropic API.',
    needsKey: true,
    needsEndpoint: false,
    keyPlaceholder: 'sk-ant-…',
    namePlaceholder: 'claude-…',
    apply: { api_protocol: 'anthropic', external: true, privacy: 'external', endpoint: '', tag: 'anthropic', multimodal: true },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    blurb: 'Any model routed through OpenRouter.',
    needsKey: true,
    needsEndpoint: false,
    keyPlaceholder: 'sk-or-…',
    namePlaceholder: 'anthropic/claude-…',
    apply: { api_protocol: 'openrouter', external: true, privacy: 'external', endpoint: '', tag: 'openrouter' },
  },
  {
    id: 'ollama',
    label: 'Ollama (self-hosted)',
    blurb: 'A model served locally by Ollama.',
    needsKey: false,
    needsEndpoint: true,
    namePlaceholder: 'llama3.1',
    nameSuggestions: ['llama3.1', 'mistral'],
    endpointPlaceholder: 'http://localhost:11434/v1',
    apply: { api_protocol: 'ollama', external: false, privacy: 'internal', endpoint: 'http://localhost:11434/v1', tag: 'ollama' },
  },
  {
    id: 'vllm',
    label: 'vLLM (self-hosted)',
    blurb: 'A model served by your own vLLM instance.',
    needsKey: false,
    needsEndpoint: true,
    namePlaceholder: 'qwen3',
    nameSuggestions: ['qwen3'],
    endpointPlaceholder: 'http://localhost:8000/v1',
    apply: { api_protocol: 'vllm', external: false, privacy: 'internal', endpoint: '', tag: 'vllm' },
  },
  {
    id: 'custom',
    label: 'Custom / OpenAI-compatible',
    blurb: 'Any other OpenAI-compatible endpoint. Full manual control.',
    needsKey: true,
    needsEndpoint: true,
    keyPlaceholder: 'API key (if required)',
    namePlaceholder: 'model name',
    endpointPlaceholder: 'https://…/v1',
    apply: { api_protocol: 'openai', external: true, privacy: 'external', endpoint: '', tag: 'custom' },
  },
]

// Best-effort match of an existing saved model back to a provider preset, so the
// Edit flow lands on the right guided fields.
function inferProviderId(m: { api_protocol?: string; external?: boolean; endpoint?: string }): string {
  const proto = (m.api_protocol || '').toLowerCase()
  if (proto === 'google') return 'google'
  if (proto === 'anthropic') return 'anthropic'
  if (proto === 'openrouter') return 'openrouter'
  if (proto === 'ollama') return 'ollama'
  if (proto === 'vllm') return 'vllm'
  if (proto === 'openai' && (m.endpoint || '').includes('api.openai.com')) return 'openai'
  return 'custom'
}

function ConfigTab() {
  const confirm = useConfirm()
  const [cfg, setCfg] = useState<SystemConfigData | null>(null)
  const [loading, setLoading] = useState(true)
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
  const [ocrTesting, setOcrTesting] = useState(false)
  const [ocrTestResult, setOcrTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelTesting, setModelTesting] = useState<number | null>(null)
  const [modelTestResults, setModelTestResults] = useState<Record<number, ModelTestResult>>({})
  const [expandedModelTest, setExpandedModelTest] = useState<number | null>(null)

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

  // Add/edit model form
  const [showModelForm, setShowModelForm] = useState(false)
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null)
  const [savingModel, setSavingModel] = useState(false)
  const [newModel, setNewModel] = useState<ModelDraft>({ ...EMPTY_MODEL_DRAFT })
  const [probingContext, setProbingContext] = useState(false)
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null)
  // Add-a-Model wizard: step 1 = pick provider, step 2 = configure + save + test.
  const [wizardStep, setWizardStep] = useState<1 | 2>(1)
  const [wizardProviderId, setWizardProviderId] = useState<string | null>(null)
  const [modelTest, setModelTest] = useState<ModelTestResult | null>(null)
  const [wizardTesting, setWizardTesting] = useState(false)

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

  useEffect(() => {
    setLoading(true)
    getSystemConfig().then(c => {
      setCfg(c)
      setThemeColor(c.highlight_color || '#eab308')
      setThemeRadius(parseInt(c.ui_radius) || 12)
      setOcrEndpoint(c.ocr_endpoint || '')
      setOcrApiKey(c.ocr_api_key || '')
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
    }).catch(() => {}).finally(() => setLoading(false))

    getThemeConfig().then(t => {
      setThemeColor(t.highlight_color)
      setThemeRadius(parseInt(t.ui_radius) || 12)
      setThemeOrgName(t.org_name || '')
      setThemeLogo(t.logo_data_url || '')
      setThemeIcon(t.icon_data_url || '')
      setThemeIconHideInNav(!!t.icon_hide_in_nav)
    }).catch(() => {})
  }, [])

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
        ocr_api_key: ocrApiKey,
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

  const handleProbeContextWindow = async () => {
    setProbingContext(true)
    setProbeResult(null)
    try {
      const result = await probeModel({
        name: newModel.name,
        endpoint: newModel.endpoint,
        api_protocol: newModel.api_protocol,
        api_key: newModel.api_key,
        existing_model_index: editingModelIndex,
      })
      if (result.context_window && result.context_window > 0) {
        setNewModel(prev => ({ ...prev, context_window: result.context_window as number }))
        setProbeResult({ ok: true, message: `Detected ${result.context_window.toLocaleString()} tokens (${result.source}).` })
      } else {
        setProbeResult({ ok: false, message: result.detail || `No context length reported (${result.source}).` })
      }
    } catch (e) {
      setProbeResult({ ok: false, message: e instanceof Error ? e.message : 'Probe failed' })
    } finally {
      setProbingContext(false)
    }
  }

  // Open the wizard fresh for a new model (provider-picker step).
  const openAddModelWizard = () => {
    setNewModel({ ...EMPTY_MODEL_DRAFT })
    setProbeResult(null)
    setModelTest(null)
    setWizardProviderId(null)
    setWizardStep(1)
    setEditingModelIndex(null)
    setError(null)
    setShowModelForm(true)
  }

  const closeModelForm = () => {
    setNewModel({ ...EMPTY_MODEL_DRAFT })
    setProbeResult(null)
    setModelTest(null)
    setWizardProviderId(null)
    setWizardStep(1)
    setShowModelForm(false)
    setEditingModelIndex(null)
    setError(null)
  }

  // Wizard step 1 → 2: apply the provider's preset onto a clean draft. Starting
  // from EMPTY (keeping only a model name the admin may have typed) prevents a
  // previously-picked provider's flags — e.g. Google's 1M context window — from
  // leaking in when they switch providers via "Change".
  const selectProvider = (p: ModelProviderPreset) => {
    setWizardProviderId(p.id)
    setNewModel(prev => ({ ...EMPTY_MODEL_DRAFT, name: prev.name, ...p.apply }))
    setProbeResult(null)
    setModelTest(null)
    setError(null)
    setWizardStep(2)
  }

  const handleSaveModel = async () => {
    if (!newModel.name.trim()) {
      setError('Enter a model name')
      return
    }
    if (!newModel.tag.trim()) {
      setError('A tag is required (set one under Advanced settings)')
      return
    }
    setSavingModel(true)
    setError(null)
    setModelTest(null)
    try {
      let res
      let savedIndex: number
      if (editingModelIndex !== null) {
        res = await updateModel(editingModelIndex, newModel)
        savedIndex = editingModelIndex
      } else {
        res = await addModel(newModel)
        savedIndex = res.models.length - 1
      }
      if (cfg) {
        const resDefault = (res as { default_model?: string }).default_model
        setCfg({
          ...cfg,
          available_models: res.models,
          ...(resDefault !== undefined ? { default_model: resDefault } : {}),
        })
      }
      // The model is now saved — subsequent edits/tests target its index.
      setEditingModelIndex(savedIndex)
      void refreshReadiness()
      // Auto-run a connection test so the admin gets a clear pass/fail without
      // having to know where the test button lives.
      setWizardTesting(true)
      try {
        const t = await testModel(savedIndex)
        setModelTest(t)
      } catch (e) {
        setModelTest({
          ok: false,
          checks: [],
          summary: 'Saved, but the connection test could not run.',
          error: { category: 'client', title: 'Test request failed', why: e instanceof Error ? e.message : 'Unknown error', fix: 'The model is saved. Re-run the test from the model list, or check your network.', raw: '' },
        })
      } finally {
        setWizardTesting(false)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save model')
    } finally {
      setSavingModel(false)
    }
  }

  const handleEditModel = (index: number) => {
    const m = cfg?.available_models[index]
    if (!m) return
    setNewModel({
      name: m.name,
      tag: m.tag,
      external: m.external,
      thinking: m.thinking,
      endpoint: m.endpoint || '',
      api_protocol: m.api_protocol || '',
      api_key: m.api_key || '',
      speed: m.speed || '',
      tier: m.tier || '',
      privacy: m.privacy || '',
      supports_structured: m.supports_structured !== false,
      multimodal: !!m.multimodal,
      supports_pdf: !!m.supports_pdf,
      context_window: typeof m.context_window === 'number' && m.context_window > 0 ? m.context_window : 128000,
      request_timeout_seconds: typeof m.request_timeout_seconds === 'number' && m.request_timeout_seconds > 0 ? m.request_timeout_seconds : 0,
      response_reserve_tokens: typeof m.response_reserve_tokens === 'number' && m.response_reserve_tokens > 0 ? m.response_reserve_tokens : 0,
    })
    setProbeResult(null)
    setModelTest(null)
    setWizardProviderId(inferProviderId(m))
    setWizardStep(2)          // edit skips the provider picker
    setEditingModelIndex(index)
    setShowModelForm(true)
  }

  const handleDeleteModel = async (index: number) => {
    const model = cfg?.available_models?.[index]
    const ok = await confirm({
      title: 'Delete model?',
      message: (
        <>
          Are you sure you want to delete the model <strong>{model?.name || 'this model'}</strong>? Workflows and chats configured to use it will fail until reconfigured.
        </>
      ),
      confirmLabel: 'Delete',
      destructive: true,
    })
    if (!ok) return
    try {
      const res = await deleteModel(index)
      if (cfg) {
        const models = [...cfg.available_models]
        models.splice(index, 1)
        setCfg({
          ...cfg,
          available_models: models,
          ...(res.default_model !== undefined ? { default_model: res.default_model } : {}),
        })
      }
      // Dropping a model can clear the only configured LLM — re-grade setup.
      setModelTestResults(prev => { const next = { ...prev }; delete next[index]; return next })
      void refreshReadiness()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete model')
    }
  }

  const handleSetDefaultModel = async (name: string) => {
    try {
      // Toggle off if clicking the current default.
      const next = cfg?.default_model === name ? '' : name
      const res = await setDefaultModel(next)
      if (cfg) setCfg({ ...cfg, default_model: res.default_model })
      void refreshReadiness()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set default model')
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

  const handleTestModel = async (index: number) => {
    setModelTesting(index)
    setModelTestResults(prev => { const next = { ...prev }; delete next[index]; return next })
    try {
      const res = await testModel(index)
      setModelTestResults(prev => ({ ...prev, [index]: res }))
      // Auto-expand so the admin sees the breakdown — especially on failure.
      setExpandedModelTest(index)
      // A successful test means readiness may have changed.
      if (res.ok) void refreshReadiness()
    } catch (e) {
      // Transport-level failure (network/permission) — synthesize a result.
      const message = e instanceof Error ? e.message : 'Test failed'
      setModelTestResults(prev => ({
        ...prev,
        [index]: {
          ok: false,
          checks: [{ label: 'Request', ok: false, detail: message }],
          summary: message,
          error: { category: 'transport', title: 'Could not run the test', why: message, fix: 'Check that you are still signed in as an admin and the backend is reachable.', raw: message },
        },
      }))
      setExpandedModelTest(index)
    } finally {
      setModelTesting(null)
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
    try {
      await updateAuthMethods(authMethods)
      void refreshReadiness()
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
    try {
      await deleteOAuthProvider(index)
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
    setProviderError('')
    try {
      await updateOAuthProvider(editingProviderIndex, editingProvider as unknown as Record<string, string>)
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

  const sectionStyle = {
    background: '#fff', border: '1px solid #e5e7eb', borderRadius: 'var(--ui-radius, 12px)', overflow: 'hidden' as const,
  }
  const sectionHeaderStyle = {
    padding: '14px 20px', borderBottom: '1px solid #e5e7eb', fontSize: 15, fontWeight: 600 as const,
    display: 'flex', alignItems: 'center', gap: 10,
  }
  const sectionBodyStyle = { padding: 20 }
  const labelStyle = { display: 'block', fontSize: 13, fontWeight: 500 as const, color: '#374151', marginBottom: 6 }
  const inputStyle = {
    width: '100%', padding: '8px 12px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
    fontSize: 14, outline: 'none',
  }
  const checkStyle = { marginRight: 8, accentColor: 'var(--highlight-color, #eab308)' }

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
            // find the "Add Model" button. Only when none exists and it isn't open.
            if (target === 'models' && !(cfg?.available_models && cfg.available_models.length > 0) && !showModelForm) {
              openAddModelWizard()
            }
          }}
          onDismiss={readiness.ready ? () => setSetupDismissed(true) : undefined}
        />
      )}

      {/* Available Models */}
      <div id="cfg-models" style={sectionStyle}>
        <div style={sectionHeaderStyle}>
          <Cpu size={18} color="#6b7280" /> Available Models
          <div style={{ flex: 1 }} />
          <button
            onClick={() => { if (showModelForm) { closeModelForm() } else { openAddModelWizard() } }}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, padding: '6px 12px',
              borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
              fontSize: 13, fontWeight: 500, cursor: 'pointer', background: '#fff',
            }}
          >
            <Plus size={14} /> Add Model
          </button>
        </div>
        <div style={sectionBodyStyle}>
          {cfg?.available_models && cfg.available_models.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {cfg.available_models.map((m, i) => {
                const test = modelTestResults[i]
                const expanded = expandedModelTest === i
                return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 16px',
                  background: test ? (test.ok ? '#f0fdf4' : '#fef2f2') : '#f9fafb',
                  borderRadius: expanded ? 'var(--ui-radius, 12px) var(--ui-radius, 12px) 0 0' : 'var(--ui-radius, 12px)',
                  border: '1px solid',
                  borderColor: test ? (test.ok ? '#bbf7d0' : '#fecaca') : '#e5e7eb',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    {/* Identity & capability badges */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{m.name}</span>
                      <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#f3f4f6', color: '#6b7280', fontWeight: 600 }}>{m.tag}</span>
                      {cfg?.default_model === m.name && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#fef9c3', color: '#854d0e', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <Star size={11} fill="currentColor" /> Default
                        </span>
                      )}
                      {m.external && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>External</span>
                      )}
                      {m.thinking && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#dbeafe', color: '#1e40af', fontWeight: 600 }}>Thinking</span>
                      )}
                      {m.multimodal && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#ede9fe', color: '#5b21b6', fontWeight: 600 }}>Multimodal</span>
                      )}
                      {m.supports_pdf && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#fce7f3', color: '#9d174d', fontWeight: 600 }}>PDF Input</span>
                      )}
                      {m.api_protocol && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#e0e7ff', color: '#3730a3', fontWeight: 600 }}>{m.api_protocol}</span>
                      )}
                      {m.api_key && (
                        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 9999, background: '#d1fae5', color: '#065f46', fontWeight: 600 }}>API Key ✓</span>
                      )}
                      {m.endpoint && (
                        <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>{m.endpoint}</span>
                      )}
                    </div>
                    {/* Characteristic bars (replaces speed / tier / privacy pills) */}
                    <ModelCharacterBars model={m as ModelInfo} />
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {test && (
                      <button
                        onClick={() => setExpandedModelTest(expanded ? null : i)}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 4,
                          padding: '3px 8px', borderRadius: 9999, cursor: 'pointer', border: '1px solid',
                          borderColor: test.ok ? '#86efac' : '#fca5a5',
                          background: test.ok ? '#dcfce7' : '#fee2e2',
                          color: test.ok ? '#166534' : '#991b1b', fontSize: 12, fontWeight: 600,
                        }}
                        title={expanded ? 'Hide details' : 'Show details'}
                      >
                        {test.ok ? <CheckCircle2 size={13} /> : <XCircle size={13} />}
                        <span style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {test.ok ? 'Connected' : (test.error?.title || 'Failed')}
                        </span>
                        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      </button>
                    )}
                    <button
                      onClick={() => handleSetDefaultModel(m.name)}
                      style={{
                        background: 'none', border: 'none', cursor: 'pointer',
                        color: cfg?.default_model === m.name ? '#ca8a04' : '#9ca3af',
                        padding: 4,
                      }}
                      title={cfg?.default_model === m.name ? 'Remove as default' : 'Set as default model'}
                    >
                      <Star size={16} fill={cfg?.default_model === m.name ? 'currentColor' : 'none'} />
                    </button>
                    <button
                      onClick={() => handleTestModel(i)}
                      disabled={modelTesting === i}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: modelTesting === i ? '#9ca3af' : '#6b7280', padding: 4 }}
                      title={modelTesting === i ? 'Testing...' : 'Test model'}
                    >
                      {modelTesting === i ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                    </button>
                    <button
                      onClick={() => handleEditModel(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#6b7280', padding: 4 }}
                      title="Edit model"
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      onClick={() => handleDeleteModel(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ef4444', padding: 4 }}
                      title="Delete model"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                {expanded && test && <ModelTestDiagnostics result={test} />}
                </div>
                )
              })}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: '#6b7280' }}>No models configured.</div>
          )}

          {showModelForm && (() => {
            const prov = MODEL_PROVIDERS.find(p => p.id === wizardProviderId) ?? null
            const isEditing = editingModelIndex !== null
            const needsKey = prov?.needsKey ?? true
            const needsEndpoint = prov?.needsEndpoint ?? false
            const secondaryBtn = {
              padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #d1d5db',
              background: '#fff', fontSize: 13, cursor: 'pointer',
            } as const
            const primaryBtn = {
              padding: '8px 16px', borderRadius: 'var(--ui-radius, 12px)', border: 'none',
              background: 'var(--highlight-color, #eab308)', color: 'var(--highlight-text-color, #000)',
              fontSize: 13, fontWeight: 600, cursor: 'pointer',
            } as const
            const checkboxLabel = { display: 'flex', alignItems: 'center', fontSize: 14, cursor: 'pointer' } as const
            return (
            <div style={{ marginTop: 16, padding: 16, background: '#f9fafb', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{isEditing ? 'Edit model' : 'Add a model'}</div>
                {!isEditing && (
                  <div style={{ fontSize: 12, color: '#6b7280' }}>
                    {wizardStep === 1 ? 'Step 1 of 2 · Choose a provider' : 'Step 2 of 2 · Configure'}
                  </div>
                )}
              </div>

              {/* STEP 1 — provider picker (new models only) */}
              {wizardStep === 1 && !isEditing && (
                <>
                  <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                    Choose where this model runs — we&rsquo;ll fill in the technical settings for you.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    {MODEL_PROVIDERS.map(p => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => selectProvider(p)}
                        style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 'var(--ui-radius, 12px)', border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer' }}
                      >
                        <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{p.label}</div>
                        <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3 }}>{p.blurb}</div>
                      </button>
                    ))}
                  </div>
                  <div style={{ marginTop: 14 }}>
                    <button onClick={closeModelForm} style={secondaryBtn}>Cancel</button>
                  </div>
                </>
              )}

              {/* STEP 2 — configure, save, test */}
              {wizardStep === 2 && (
                <>
                  {prov && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                      <span style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, background: '#eef2ff', color: '#3730a3', fontWeight: 600 }}>{prov.label}</span>
                      {!isEditing && (
                        <button type="button" onClick={() => { setWizardStep(1); setModelTest(null) }} style={{ fontSize: 12, color: '#4f46e5', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>Change</button>
                      )}
                    </div>
                  )}

                  {/* Guided fields */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div>
                      <label htmlFor="admin-model-name" style={labelStyle}>Model name</label>
                      <input id="admin-model-name" value={newModel.name} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, name: v })) }} placeholder={prov?.namePlaceholder ?? 'model name'} style={inputStyle} />
                      {prov?.nameSuggestions && prov.nameSuggestions.length > 0 && (
                        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                          {prov.nameSuggestions.map(s => (
                            <button key={s} type="button" onClick={() => setNewModel(prev => ({ ...prev, name: s }))} style={{ fontSize: 12, padding: '3px 10px', borderRadius: 999, border: '1px solid #d1d5db', background: '#fff', cursor: 'pointer', color: '#374151' }}>{s}</button>
                          ))}
                        </div>
                      )}
                    </div>

                    {needsKey && (
                      <div>
                        <label htmlFor="admin-model-apikey" style={labelStyle}>API key</label>
                        <input id="admin-model-apikey" type="password" autoComplete="new-password" data-1p-ignore data-lpignore="true" data-bwignore name="vandalizer-model-api-key" value={newModel.api_key} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, api_key: v })) }} placeholder={prov?.keyPlaceholder ?? 'API key'} style={inputStyle} />
                        {prov?.keyHelp && <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{prov.keyHelp}</div>}
                      </div>
                    )}

                    {needsEndpoint && (
                      <div>
                        <label htmlFor="admin-model-endpoint" style={labelStyle}>Endpoint</label>
                        <input id="admin-model-endpoint" value={newModel.endpoint} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, endpoint: v })) }} placeholder={prov?.endpointPlaceholder ?? 'https://…/v1'} style={inputStyle} />
                      </div>
                    )}

                    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                      <label style={checkboxLabel}>
                        <input type="checkbox" checked={newModel.multimodal} onChange={e => { const v = e.target.checked; setNewModel(prev => ({ ...prev, multimodal: v, supports_pdf: v ? prev.supports_pdf : false })) }} style={checkStyle} />
                        Handles images / PDFs
                      </label>
                      <label style={checkboxLabel}>
                        <input type="checkbox" checked={newModel.thinking} onChange={e => { const v = e.target.checked; setNewModel(prev => ({ ...prev, thinking: v })) }} style={checkStyle} />
                        Extended thinking
                      </label>
                    </div>
                  </div>

                  {/* Advanced settings — everything from the old form lives here */}
                  <details style={{ marginTop: 14 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 13, color: '#4b5563', fontWeight: 500 }}>Advanced settings</summary>
                    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <label htmlFor="admin-model-tag" style={labelStyle}>Tag</label>
                          <input id="admin-model-tag" value={newModel.tag} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, tag: v })) }} placeholder="provider" style={inputStyle} />
                        </div>
                        <div>
                          <label htmlFor="admin-model-protocol" style={labelStyle}>API protocol</label>
                          <select id="admin-model-protocol" value={newModel.api_protocol} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, api_protocol: v })) }} style={inputStyle}>
                            <option value="">Auto-detect</option>
                            <option value="openai">OpenAI</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="google">Google (Gemini)</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="ollama">Ollama</option>
                            <option value="vllm">VLLM</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="admin-model-speed" style={labelStyle}>Speed</label>
                          <select id="admin-model-speed" value={newModel.speed} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, speed: v })) }} style={inputStyle}>
                            <option value="">Not set</option>
                            <option value="fast">Fast</option>
                            <option value="standard">Standard</option>
                            <option value="slow">Slow</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="admin-model-tier" style={labelStyle}>Tier</label>
                          <select id="admin-model-tier" value={newModel.tier} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, tier: v })) }} style={inputStyle}>
                            <option value="">Not set</option>
                            <option value="high">High</option>
                            <option value="standard">Standard</option>
                            <option value="basic">Basic</option>
                          </select>
                        </div>
                        <div>
                          <label htmlFor="admin-model-privacy" style={labelStyle}>Privacy</label>
                          <select id="admin-model-privacy" value={newModel.privacy} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, privacy: v })) }} style={inputStyle}>
                            <option value="">Not set</option>
                            <option value="internal">Internal</option>
                            <option value="external">External</option>
                          </select>
                        </div>
                        {!needsEndpoint && (
                          <div>
                            <label htmlFor="admin-model-endpoint-adv" style={labelStyle}>Endpoint (optional)</label>
                            <input id="admin-model-endpoint-adv" value={newModel.endpoint} onChange={e => { const v = e.target.value; setNewModel(prev => ({ ...prev, endpoint: v })) }} placeholder="https://..." style={inputStyle} />
                          </div>
                        )}
                      </div>

                      <div>
                        <label htmlFor="admin-model-context-window" style={labelStyle}>Context window (tokens)</label>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
                          <input
                            id="admin-model-context-window"
                            type="number"
                            min={1}
                            value={newModel.context_window}
                            onChange={e => {
                              const v = parseInt(e.target.value, 10)
                              setNewModel(prev => ({ ...prev, context_window: Number.isFinite(v) && v > 0 ? v : 0 }))
                              setProbeResult(null)
                            }}
                            placeholder="e.g. 65536"
                            style={{ ...inputStyle, flex: 1 }}
                          />
                          <button
                            onClick={handleProbeContextWindow}
                            disabled={probingContext || !newModel.name.trim()}
                            title="Ask the endpoint what context window it actually serves. Catches the case where the model card says 131k but the deployment was launched with a smaller --max-model-len."
                            style={{
                              padding: '0 14px', borderRadius: 'var(--ui-radius, 12px)',
                              border: '1px solid #d1d5db', background: '#fff', fontSize: 13,
                              cursor: probingContext || !newModel.name.trim() ? 'not-allowed' : 'pointer',
                              opacity: probingContext || !newModel.name.trim() ? 0.6 : 1,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {probingContext ? 'Probing…' : 'Probe endpoint'}
                          </button>
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                          The serving cap (e.g. vLLM&rsquo;s <code>--max-model-len</code>), not the model card&rsquo;s theoretical max. Compaction and the oversize-doc check use this to decide what fits.
                        </div>
                        {probeResult && (
                          <div role="status" aria-live="polite" style={{
                            marginTop: 6, padding: '6px 10px', borderRadius: 'var(--ui-radius, 12px)',
                            background: probeResult.ok ? '#ecfdf5' : '#fef3c7',
                            border: `1px solid ${probeResult.ok ? '#a7f3d0' : '#fcd34d'}`,
                            color: probeResult.ok ? '#065f46' : '#92400e',
                            fontSize: 12,
                          }}>
                            {probeResult.message}
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                        <div>
                          <label htmlFor="admin-model-timeout" style={labelStyle}>Request timeout (seconds)</label>
                          <input
                            id="admin-model-timeout"
                            type="number"
                            min={0}
                            value={newModel.request_timeout_seconds || ''}
                            onChange={e => { const v = parseInt(e.target.value, 10); setNewModel(prev => ({ ...prev, request_timeout_seconds: Number.isFinite(v) && v > 0 ? v : 0 })) }}
                            placeholder="system default"
                            style={inputStyle}
                          />
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                            Overrides the shared LLM timeout for this model — raise it for slow self-hosted models. Blank = system default.
                          </div>
                        </div>
                        <div>
                          <label htmlFor="admin-model-reserve" style={labelStyle}>Response reserve (output tokens)</label>
                          <input
                            id="admin-model-reserve"
                            type="number"
                            min={0}
                            value={newModel.response_reserve_tokens || ''}
                            onChange={e => { const v = parseInt(e.target.value, 10); setNewModel(prev => ({ ...prev, response_reserve_tokens: Number.isFinite(v) && v > 0 ? v : 0 })) }}
                            placeholder="auto"
                            style={inputStyle}
                          />
                          <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
                            Tokens reserved for the model&rsquo;s answer; also caps runaway reasoning. More output room means less input room. Blank = scaled to the context window.
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                        <label style={checkboxLabel}>
                          <input type="checkbox" checked={newModel.external} onChange={e => { const v = e.target.checked; setNewModel(prev => ({ ...prev, external: v })) }} style={checkStyle} />
                          External
                        </label>
                        <label style={checkboxLabel}>
                          <input type="checkbox" checked={newModel.supports_structured} onChange={e => { const v = e.target.checked; setNewModel(prev => ({ ...prev, supports_structured: v })) }} style={checkStyle} />
                          Supports structured output
                        </label>
                        {newModel.multimodal && (
                          <label style={checkboxLabel}>
                            <input type="checkbox" checked={newModel.supports_pdf} onChange={e => { const v = e.target.checked; setNewModel(prev => ({ ...prev, supports_pdf: v })) }} style={checkStyle} />
                            Supports PDF input
                          </label>
                        )}
                      </div>
                    </div>
                  </details>

                  {error && (
                    <div style={{ marginTop: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 'var(--ui-radius, 12px)', color: '#991b1b', fontSize: 13 }}>
                      {error}
                    </div>
                  )}

                  {wizardTesting && (
                    <div role="status" aria-live="polite" style={{ marginTop: 12, fontSize: 13, color: '#6b7280' }}>
                      Testing connection…
                    </div>
                  )}
                  {modelTest && !wizardTesting && (
                    <div style={{ marginTop: 12 }}>
                      <ModelTestDiagnostics result={modelTest} />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                    {!modelTest ? (
                      <>
                        <button onClick={handleSaveModel} disabled={savingModel || wizardTesting} style={{ ...primaryBtn, opacity: savingModel || wizardTesting ? 0.6 : 1 }}>
                          {savingModel ? 'Saving…' : wizardTesting ? 'Testing…' : 'Save & test connection'}
                        </button>
                        {!isEditing && <button onClick={() => { setWizardStep(1); setModelTest(null) }} style={secondaryBtn}>Back</button>}
                        <button onClick={closeModelForm} style={secondaryBtn}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button onClick={closeModelForm} style={primaryBtn}>Done</button>
                        <button onClick={handleSaveModel} disabled={savingModel || wizardTesting} style={{ ...secondaryBtn, opacity: savingModel || wizardTesting ? 0.6 : 1 }}>
                          {savingModel || wizardTesting ? 'Testing…' : 'Save & re-test'}
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </div>
            )
          })()}
        </div>
      </div>

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
              {['password', 'oauth'].map(m => (
                <label key={m} style={{ display: 'flex', alignItems: 'center', fontSize: 14, cursor: 'pointer', textTransform: 'capitalize' }}>
                  <input
                    type="checkbox"
                    checked={authMethods.includes(m)}
                    onChange={e => {
                      if (e.target.checked) setAuthMethods(prev => [...prev, m])
                      else setAuthMethods(prev => prev.filter(x => x !== m))
                    }}
                    style={checkStyle}
                  />
                  {m === 'oauth' ? 'OAuth / SAML' : m}
                </label>
              ))}
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
              value={ocrApiKey} onChange={e => setOcrApiKey(e.target.value)}
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

// ──────────────────────────────────────────
// Main Admin Component
// ──────────────────────────────────────────

export default function Admin() {
  const { user } = useAuth()
  const { currentTeam } = useTeams()
  const [activeTab, setActiveTab] = useState<Tab>('usage')
  const [trialEnabled, setTrialEnabled] = useState(false)
  // Only true on the fleet collector instance; hides the Telemetry tab elsewhere.
  const [telemetryCollector, setTelemetryCollector] = useState(false)

  useEffect(() => {
    getAuthConfig().then(c => setTrialEnabled(!!c.trial_system_enabled)).catch(() => {})
    getFeatureFlags().then(f => setTelemetryCollector(!!f.telemetry_collector_enabled)).catch(() => {})
  }, [])

  // Honor ?tab=<key> deep links (e.g. the catalog-update notification).
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    if (requested && TABS.some(t => t.key === requested)) {
      setActiveTab(requested as Tab)
    }
  }, [])

  const isGlobalAdmin = !!user?.is_admin
  const isStaff = !!user?.is_staff
  const isTeamAdmin = currentTeam?.role === 'owner' || currentTeam?.role === 'admin'
  // Examiners are intentionally excluded: every admin-panel endpoint gates on
  // admin/staff/team-admin (see _require_admin_or_team_admin), so examiners would
  // only hit 403s here. Their workspace is the Verification queue (/verification).
  const hasAccess = isGlobalAdmin || isStaff || isTeamAdmin

  // Staff see everything except config; team admins see only team-scoped tabs whose
  // endpoints accept a team scope. Tabs whose backends require admin/staff (email,
  // plus everything in hiddenForNonAdmin) stay hidden so we never render a tab that
  // can only 403.
  const hiddenForNonAdmin = ['config', 'catalog', 'quality', 'knowledgebases', 'compliance', 'demo', 'organizations', 'approvals', 'audit', 'certifications', 'apikeys', 'email', 'teams', 'telemetry']
  let visibleTabs = isGlobalAdmin
    ? TABS
    : isStaff
      ? TABS.filter(t => t.key !== 'config' && t.key !== 'catalog')
      : TABS.filter(t => !hiddenForNonAdmin.includes(t.key))

  if (!trialEnabled) {
    visibleTabs = visibleTabs.filter(t => t.key !== 'demo')
  }
  // The Telemetry tab exists only on the collector instance.
  if (!telemetryCollector) {
    visibleTabs = visibleTabs.filter(t => t.key !== 'telemetry')
  }

  if (!hasAccess) {
    return (
      <PageLayout>
        <div style={{ maxWidth: 480, margin: '60px auto', textAlign: 'center' }}>
          <Shield size={40} color="#d1d5db" style={{ marginBottom: 16 }} />
          <h2 style={{ fontSize: 18, fontWeight: 600, color: '#111827' }}>Access Denied</h2>
          <p style={{ fontSize: 14, color: '#6b7280', marginTop: 8 }}>
            You must be a team admin or system administrator to view this page.
          </p>
        </div>
      </PageLayout>
    )
  }

  return (
    <PageLayout>
      <div style={{ display: 'flex', gap: 0, minHeight: 'calc(100vh - 130px)' }}>
        {/* Sidebar */}
        <nav aria-label="Admin sections" style={{
          width: 220, flexShrink: 0,
          borderRight: '1px solid #e5e7eb',
          backgroundColor: '#fff',
          padding: '20px 0',
          borderRadius: 'var(--ui-radius, 12px) 0 0 var(--ui-radius, 12px)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', marginBottom: 20 }}>
            <Shield size={20} color="#6b7280" />
            <h1 style={{ fontSize: 17, fontWeight: 700, margin: 0 }}>
              {isGlobalAdmin || isStaff ? 'Admin' : 'Team Admin'}
            </h1>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 8px' }}>
            {visibleTabs.map(tab => {
              const Icon = tab.icon
              const isActive = activeTab === tab.key
              return (
                <button
                  key={tab.key}
                  type="button"
                  aria-current={isActive ? 'page' : undefined}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 14px', border: 'none', cursor: 'pointer',
                    fontSize: 14, fontWeight: isActive ? 600 : 400,
                    color: isActive ? '#111827' : '#6b7280',
                    backgroundColor: isActive ? '#f3f4f6' : 'transparent',
                    borderRadius: 8, fontFamily: 'inherit',
                    transition: 'background-color 0.15s, color 0.15s',
                    width: '100%', textAlign: 'left',
                    borderLeft: isActive ? '3px solid var(--highlight-color, #eab308)' : '3px solid transparent',
                  }}
                >
                  <Icon size={18} style={{ flexShrink: 0 }} />
                  {tab.label}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Content */}
        <div style={{ flex: 1, padding: '20px 32px', minWidth: 0 }}>
          <UpdateBanner />
          {isGlobalAdmin && <CatalogUpdateBanner onView={() => setActiveTab('catalog')} />}
          {isGlobalAdmin && <TelemetryOptInBanner />}
          {activeTab === 'usage' && <UsageTab />}
          {activeTab === 'users' && <UsersTab />}
          {activeTab === 'teams' && <TeamsTab />}
          {activeTab === 'organizations' && (isGlobalAdmin || isStaff) && <OrganizationsTab />}
          {activeTab === 'workflows' && <WorkflowsTab />}
          {activeTab === 'quality' && <QualityTab />}
          {activeTab === 'knowledgebases' && (isGlobalAdmin || isStaff) && <KnowledgeBasesTab canEdit={isGlobalAdmin} />}
          {activeTab === 'compliance' && (isGlobalAdmin || isStaff) && <ComplianceTab />}
          {activeTab === 'audit' && (isGlobalAdmin || isStaff) && <AuditTab />}
          {activeTab === 'demo' && (isGlobalAdmin || isStaff) && <DemoTab />}
          {activeTab === 'email' && (isGlobalAdmin || isStaff) && <EmailAnalyticsTab />}
          {activeTab === 'certifications' && (isGlobalAdmin || isStaff) && <CertificationsTab />}
          {activeTab === 'apikeys' && (isGlobalAdmin || isStaff) && <ApiKeysTab />}
          {activeTab === 'catalog' && isGlobalAdmin && <CatalogTab />}
          {activeTab === 'telemetry' && isGlobalAdmin && telemetryCollector && <TelemetryTab />}
          {activeTab === 'config' && isGlobalAdmin && <ConfigTab />}
        </div>
      </div>
    </PageLayout>
  )
}
