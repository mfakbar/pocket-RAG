import { ArrowRight, FileText, Lock, Shield, Zap } from 'lucide-react'
import { ThemeAwareAppIcon } from '../components/ui'

export default function WelcomeScreen({
  onBegin,
  workspaceReady
}: {
  onBegin: () => void
  workspaceReady: boolean
}): React.JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto px-8 py-8 text-center">
      <div className="mb-5 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-primary" />
        {workspaceReady ? 'Welcome back' : 'Welcome · 1 of 4'}
      </div>
      <div className="relative mb-6">
        <ThemeAwareAppIcon alt="RavnDock" className="mx-auto h-20 w-20" />
        <div className="absolute -top-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-emerald-400">
          <Lock className="h-3 w-3 text-emerald-950" />
        </div>
      </div>

      <h1 className="mb-3 text-4xl font-semibold text-foreground">RavnDock</h1>
      <p className="mb-2 max-w-md text-lg text-muted-foreground">
        Private AI chat for your documents
      </p>
      <p className="mb-10 max-w-md text-sm leading-relaxed text-muted-foreground">
        Choose a local folder, we’ll prepare the model, then ask questions in plain language.
      </p>

      <div className="mb-10 grid w-full max-w-lg grid-cols-3 gap-4">
        {[
          { icon: Shield, label: 'Local by default', sub: 'Documents stay on your Mac' },
          { icon: Zap, label: 'Simple workflow', sub: 'Choose, sync, and chat' },
          { icon: FileText, label: 'Various file types', sub: 'PDF, Office, CSV, and text' }
        ].map(({ icon: Icon, label, sub }) => (
          <div key={label} className="soft-primary-card rounded-lg p-4 text-center">
            <Icon className="mx-auto mb-2 h-5 w-5 text-primary" />
            <div className="mb-0.5 text-xs font-semibold text-foreground">{label}</div>
            <div className="text-xs leading-snug text-muted-foreground">{sub}</div>
          </div>
        ))}
      </div>

      <button
        onClick={onBegin}
        className="primary-action flex items-center gap-2 rounded-xl px-8 py-3.5 text-sm font-semibold"
      >
        {workspaceReady ? 'Get started' : 'Prepare RavnDock'}
        <ArrowRight className="h-4 w-4" />
      </button>
      <p className="mt-3 text-[11px] text-muted-foreground">
        {workspaceReady
          ? 'Your private workspace is ready on this Mac.'
          : 'We’ll download the local tools and model during setup. Nothing is uploaded.'}
      </p>
    </div>
  )
}
