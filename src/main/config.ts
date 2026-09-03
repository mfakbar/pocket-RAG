import {
  CHAT_MODEL,
  EMBEDDING_MODEL,
  RERANKER_MODEL,
  HIGH_QUALITY_MODEL,
  PERFORMANCE_MODEL
} from '../shared/contracts'

export const runtimeConfig = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  ollamaDownloadUrl: 'https://ollama.com/download/Ollama-darwin.zip',
  uvDownloadUrl:
    'https://github.com/astral-sh/uv/releases/download/0.11.32/uv-aarch64-apple-darwin.tar.gz',
  uvDownloadSha256: 'ed336d0ba49db8ef89b2b41fffa372ce63bd032f22a56f001c265891aec32829',
  chatModel: CHAT_MODEL,
  performanceModel: PERFORMANCE_MODEL,
  highQualityModel: HIGH_QUALITY_MODEL,
  embeddingModel: EMBEDDING_MODEL,
  rerankerModel: RERANKER_MODEL
} as const
