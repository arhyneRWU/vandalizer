import { useEffect, useState } from 'react'
import {
  Shield, ShieldCheck, BarChart3, Users, Building2, Workflow, Settings,
  Lock, Globe, Zap,
  FileText, FolderTree,
  Mail, Award, KeyRound, PackageOpen,
  BookOpen,
} from 'lucide-react'
import { PageLayout } from '../components/layout/PageLayout'
import { useAuth } from '../hooks/useAuth'
import { useTeams } from '../hooks/useTeams'
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
import { ConfigTab } from '../components/admin/ConfigTab'
import { getFeatureFlags } from '../api/config'

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
