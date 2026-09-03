import { CircleHelp, FolderOpen } from 'lucide-react'
import { useState } from 'react'
import type { AppSettings } from '../../../shared/contracts'
import { Modal } from './ui/Modal'

export function CreateKnowledgeBaseModal({
  open,
  onClose,
  onCreated
}: {
  open: boolean
  onClose: () => void
  onCreated: (settings: AppSettings) => Promise<void> | void
}): React.JSX.Element {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [instructions, setInstructions] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const close = (): void => {
    setName('')
    setDescription('')
    setInstructions('')
    setMessage('')
    onClose()
  }

  const create = async (): Promise<void> => {
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
      await onCreated(created)
      close()
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : 'This knowledge base could not be created.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      title="Create a knowledge base"
      description="Give your files a clear name and a little context so RavnDock can help you better."
      onClose={close}
      width="max-w-lg"
    >
      <div className="space-y-3 overflow-y-auto px-5 py-4">
        <label className="block text-xs text-muted-foreground">
          Name
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
            rows={3}
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
        {message && <p className="text-[11px] text-primary">{message}</p>}
      </div>
      <footer className="flex justify-end gap-2 border-t border-white/[0.08] px-5 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={close}
          className="rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-white/5 hover:text-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !name.trim() || !description.trim()}
          onClick={() => void create()}
          className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {busy ? 'Creating...' : 'Choose folder and create'}
        </button>
        <span
          className="inline-flex h-7 w-7 items-center justify-center text-muted-foreground"
          title="Supported files: PDF, Word, PowerPoint, Excel, CSV, text, and Markdown. Scanned PDFs can use local text recognition."
          aria-label="Supported file types: PDF, Word, PowerPoint, Excel, CSV, text, and Markdown."
        >
          <CircleHelp className="h-4 w-4" />
        </span>
      </footer>
    </Modal>
  )
}
