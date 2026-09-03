import { ArrowLeft, ArrowRight, CircleHelp, FolderOpen, Lock } from 'lucide-react'
import { useState } from 'react'
import { friendlyActionError } from '../lib/errors'

function folderName(folder: string): string {
  return folder.split('/').filter(Boolean).at(-1) ?? folder
}

export default function FolderSetupScreen({
  knowledgeFolder,
  hasKnowledgeBase,
  setKnowledgeFolder,
  onCreated,
  onBack,
  onContinue
}: {
  knowledgeFolder: string
  hasKnowledgeBase: boolean
  setKnowledgeFolder: (folder: string) => void
  onCreated: () => Promise<void>
  onBack: () => void
  onContinue: () => void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const chooseFolder = async (): Promise<void> => {
    const selected = await window.api.selectFolder()
    if (selected) setKnowledgeFolder(selected)
  }

  const createAndPrepare = async (): Promise<void> => {
    if (!name.trim() || !description.trim()) return
    setBusy(true)
    setMessage('Choose the folder with the files you want to use.')
    try {
      const created = await window.api.createKnowledgeBase({
        name: name.trim(),
        description: description.trim(),
        customInstructions: instructions.trim()
      })
      if (!created) {
        setMessage('No folder was selected.')
        return
      }
      setKnowledgeFolder(created.knowledgeFolder)
      await onCreated()
      onContinue()
    } catch (error) {
      setMessage(friendlyActionError(error, 'Your knowledge base could not be created.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto px-8 py-7">
      <button
        onClick={onBack}
        className="mb-5 flex w-fit items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back
      </button>

      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center text-center">
        <div className="mb-5 flex items-center justify-center gap-2 text-[11px] font-medium text-muted-foreground">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          Knowledge base · 2 of 4
        </div>
        <div className="soft-primary-card mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl">
          <FolderOpen className="h-7 w-7 text-primary" />
        </div>
        <h2 className="mb-2 text-2xl font-semibold text-foreground">
          {hasKnowledgeBase ? 'Prepare your knowledge base' : 'Create your first knowledge base'}
        </h2>
        <p className="mx-auto mb-5 max-w-md text-sm leading-relaxed text-muted-foreground">
          {hasKnowledgeBase
            ? 'Review your folder, then RavnDock will prepare its files for private chat.'
            : 'Name your collection and describe what it contains. This helps RavnDock understand how to use your files.'}
        </p>

        {hasKnowledgeBase ? (
          <button
            onClick={() => void chooseFolder()}
            className="soft-primary-card mb-4 flex min-h-20 w-full items-center gap-4 rounded-lg px-5 py-4 text-left hover:bg-primary/20"
          >
            <FolderOpen className="h-5 w-5 flex-shrink-0 text-primary" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">{folderName(knowledgeFolder)}</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{knowledgeFolder}</p>
            </div>
            <span className="text-xs font-medium text-primary">Change</span>
          </button>
        ) : (
          <div className="space-y-3 rounded-lg border border-white/10 bg-white/[0.025] p-4 text-left">
            <label className="block text-xs text-muted-foreground">
              Knowledge-base name
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Example: Customer proposals"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-input px-3 py-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              What are these files about?
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Example: Proposals, pricing, and partnership documents for my sales work."
                rows={2}
                className="mt-1.5 w-full resize-none rounded-lg border border-white/10 bg-input px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Optional answer instructions
              </summary>
              <textarea
                value={instructions}
                onChange={(event) => setInstructions(event.target.value)}
                placeholder="Example: Keep answers concise and always mention the source."
                rows={2}
                className="mt-2 w-full resize-none rounded-lg border border-white/10 bg-input px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
              />
            </details>
          </div>
        )}

        <div className="my-4 flex items-center justify-center gap-2 text-xs text-emerald-300">
          <Lock className="h-3.5 w-3.5" />
          Only your chosen folder is added to this private knowledge base
        </div>
        {message && (
          <p className="mb-3 text-xs text-primary" role="status">
            {message}
          </p>
        )}

        <button
          onClick={() => (hasKnowledgeBase ? onContinue() : void createAndPrepare())}
          disabled={
            busy || (hasKnowledgeBase ? !knowledgeFolder : !name.trim() || !description.trim())
          }
          className="primary-action mx-auto flex items-center gap-2 rounded-xl px-7 py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy
            ? 'Creating your knowledge base...'
            : hasKnowledgeBase
              ? 'Prepare and sync'
              : 'Choose folder and prepare'}
          {!busy && <ArrowRight className="h-4 w-4" />}
        </button>
        <p className="mt-3 flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
          We’ll prepare the local AI, then sync the supported files in this folder.
          <span
            className="inline-flex text-muted-foreground"
            title="Supported files: PDF, Word, PowerPoint, Excel, CSV, text, and Markdown. Scanned PDFs can use local text recognition."
            aria-label="Supported file types: PDF, Word, PowerPoint, Excel, CSV, text, and Markdown."
          >
            <CircleHelp className="h-3.5 w-3.5" />
          </span>
        </p>
      </div>
    </div>
  )
}
