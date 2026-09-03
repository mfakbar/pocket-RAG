import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelOption } from '../../../shared/contracts'
import { formatBytes } from '../lib/format'
import { Modal } from './ui/Modal'

export function InstalledModelsModal({
  open,
  models,
  onClose,
  onDelete
}: {
  open: boolean
  models: ModelOption[]
  onClose: () => void
  onDelete: (model: string) => Promise<void>
}): React.JSX.Element {
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(0)
  const [deleting, setDeleting] = useState('')
  const pageCount = Math.max(1, Math.ceil(models.length / pageSize))
  const visiblePage = Math.min(page, pageCount - 1)
  const visibleModels = useMemo(
    () => models.slice(visiblePage * pageSize, (visiblePage + 1) * pageSize),
    [models, pageSize, visiblePage]
  )

  const close = (): void => {
    setPage(0)
    onClose()
  }

  return (
    <Modal
      open={open}
      title="Installed chat models"
      description="Models stored on this Mac and ready to use in RavnDock."
      onClose={close}
    >
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {visibleModels.length === 0 ? (
          <p className="py-12 text-center text-xs text-muted-foreground">
            No chat models are installed yet.
          </p>
        ) : (
          <div className="divide-y divide-white/[0.06]">
            {visibleModels.map((model) => (
              <div key={model.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-foreground">{model.id}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    {model.parameterSize} · {model.quantization} ·{' '}
                    {formatBytes(model.sizeBytes, {
                      unavailable: 'Size unavailable',
                      zero: 'Size unavailable'
                    })}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={Boolean(deleting)}
                  onClick={() => {
                    setDeleting(model.id)
                    void onDelete(model.id).finally(() => setDeleting(''))
                  }}
                  title={`Delete ${model.id}`}
                  className="rounded-md p-2 text-muted-foreground hover:bg-red-400/10 hover:text-red-300 disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      <footer className="flex flex-shrink-0 items-center justify-between gap-4 border-t border-white/[0.08] px-5 py-3">
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Show
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value))
              setPage(0)
            }}
            className="rounded-md border border-white/10 bg-input px-2 py-1 text-xs text-foreground"
          >
            {[10, 20, 30].map((amount) => (
              <option key={amount} value={amount}>
                {amount}
              </option>
            ))}
          </select>
          of {models.length}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            Page {visiblePage + 1} of {pageCount}
          </span>
          <button
            type="button"
            disabled={visiblePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            title="Previous page"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            disabled={visiblePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            title="Next page"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </footer>
    </Modal>
  )
}
