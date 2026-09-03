from __future__ import annotations

import math
import os
import resource
import hashlib
import sys
import time
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

import requests


class LocalReranker:
    MODEL = "BAAI/bge-reranker-v2-m3"
    MODELS = {
        "BAAI/bge-reranker-v2-m3": "c0abf900d43de6a2652b9acd221bb1b45ab65d6e",
        "BAAI/bge-reranker-base": "2cfc18c9415c912f9d8155881c133215df768a70",
    }
    MAX_CANDIDATES = 24
    MODEL_FILES = (
        "config.json",
        "model.safetensors",
        "sentencepiece.bpe.model",
        "special_tokens_map.json",
        "tokenizer.json",
        "tokenizer_config.json",
    )
    MAX_MODEL_BYTES = 3 * 1024**3

    def __init__(self, cache_dir: Path, model: str = MODEL) -> None:
        if model not in self.MODELS:
            raise ValueError("Unsupported reranker model.")
        self.cache_dir = cache_dir
        self.model = model
        self.model_revision = self.MODELS[model]
        self.model_source = os.environ.get("POCKETRAG_RERANKER_MODEL_PATH", model)
        self._tokenizer: Any = None
        self._model: Any = None
        self._device = "cpu"

    @property
    def local_model_dir(self) -> Path:
        # Preserve the original cache location so existing users do not download
        # the default model again after model selection is introduced.
        if self.model == self.MODEL:
            return self.cache_dir / "model"
        return self.cache_dir / self.model.replace("/", "--")

    def _complete_local_model(self) -> bool:
        return all(
            (path := self.local_model_dir / name).is_file()
            and path.stat().st_size > 0
            and not self._file_is_lfs_pointer(path)
            for name in self.MODEL_FILES
        )

    def _load(self) -> None:
        if self._model is not None:
            return
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._device = "mps" if torch.backends.mps.is_available() else "cpu"
        source: str | Path = self.local_model_dir if self._complete_local_model() else self.model_source
        revision = self.model_revision if source == self.model else None
        self._tokenizer = AutoTokenizer.from_pretrained(
            source,
            cache_dir=self.cache_dir,
            revision=revision,
            local_files_only=True,
            trust_remote_code=False,
        )
        self._model = AutoModelForSequenceClassification.from_pretrained(
            source,
            cache_dir=self.cache_dir,
            revision=revision,
            local_files_only=True,
            trust_remote_code=False,
            use_safetensors=True,
        ).eval()
        self._model.to(self._device)

    def prepare(self) -> dict[str, Any]:
        try:
            self._load()
            self.unload()
            return {"ready": True, "model": self.model, "downloaded": False}
        except Exception:
            if self.model_source != self.model:
                raise
        from huggingface_hub import snapshot_download

        self.cache_dir.mkdir(parents=True, exist_ok=True)
        try:
            snapshot_download(
                repo_id=self.model,
                revision=self.model_revision,
                local_dir=self.local_model_dir,
                allow_patterns=list(self.MODEL_FILES),
                max_workers=1,
            )
            if not self._complete_local_model():
                self._download_from_git_lfs()
        except Exception as primary_error:
            try:
                self._download_from_git_lfs()
            except Exception as fallback_error:
                raise RuntimeError(
                    "Improved document matching could not be downloaded. Your network may "
                    "be filtering Hugging Face model files. Try another network or ask your "
                    "network administrator to allow huggingface.co and cdn.hf.co."
                ) from Exception(f"{primary_error}; fallback: {fallback_error}")
        self._load()
        self.unload()
        return {"ready": True, "model": self.model, "downloaded": True}

    def _download_from_git_lfs(self) -> None:
        """Use Hugging Face's official Git LFS API when /resolve/ is filtered."""
        self.local_model_dir.mkdir(parents=True, exist_ok=True)
        session = requests.Session()
        session.headers.update({"User-Agent": "RavnDock/1.1 reranker-downloader"})
        base = f"https://huggingface.co/{self.model}"

        for filename in self.MODEL_FILES:
            destination = self.local_model_dir / filename
            if (
                destination.is_file()
                and destination.stat().st_size > 0
                and not self._file_is_lfs_pointer(destination)
            ):
                continue
            raw_url = f"{base}/raw/{self.model_revision}/{quote(filename)}"
            response = session.get(raw_url, timeout=(20, 120))
            response.raise_for_status()
            content = response.content
            if not self._is_lfs_pointer(content):
                if not content or len(content) > 100 * 1024**2:
                    raise RuntimeError(f"Unexpected {filename} download size.")
                self._atomic_write(destination, content)
                continue

            oid, size = self._parse_lfs_pointer(content)
            lfs_response = session.post(
                f"{base}.git/info/lfs/objects/batch",
                headers={
                    "Accept": "application/vnd.git-lfs+json",
                    "Content-Type": "application/vnd.git-lfs+json",
                },
                json={
                    "operation": "download",
                    "transfers": ["basic"],
                    "objects": [{"oid": oid, "size": size}],
                },
                timeout=(20, 120),
            )
            lfs_response.raise_for_status()
            href = lfs_response.json()["objects"][0]["actions"]["download"]["href"]
            self._validate_download_url(href)
            self._download_verified_file(session, href, destination, size, oid)

    def _download_verified_file(
        self,
        session: requests.Session,
        url: str,
        destination: Path,
        expected_size: int,
        expected_sha256: str,
    ) -> None:
        partial = destination.with_suffix(destination.suffix + ".part")
        offset = partial.stat().st_size if partial.exists() else 0
        if offset > expected_size:
            partial.unlink()
            offset = 0
        headers = {"Range": f"bytes={offset}-"} if offset else {}
        with session.get(url, headers=headers, stream=True, timeout=(20, 120)) as response:
            response.raise_for_status()
            append = offset > 0 and response.status_code == 206
            if offset and not append:
                offset = 0
            with partial.open("ab" if append else "wb") as output:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        output.write(chunk)
        if partial.stat().st_size != expected_size:
            raise RuntimeError("The reranker download was incomplete and can be resumed.")
        digest = hashlib.sha256()
        with partial.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected_sha256:
            partial.unlink(missing_ok=True)
            raise RuntimeError("The reranker download did not pass its security check.")
        os.replace(partial, destination)

    @classmethod
    def _parse_lfs_pointer(cls, content: bytes) -> tuple[str, int]:
        values = dict(
            line.split(" ", 1)
            for line in content.decode("utf-8").splitlines()
            if " " in line
        )
        oid = values.get("oid", "").removeprefix("sha256:")
        size = int(values.get("size", "0"))
        if len(oid) != 64 or not all(character in "0123456789abcdef" for character in oid):
            raise RuntimeError("The reranker model checksum is invalid.")
        if size <= 0 or size > cls.MAX_MODEL_BYTES:
            raise RuntimeError("The reranker model size is invalid.")
        return oid, size

    @staticmethod
    def _is_lfs_pointer(content: bytes) -> bool:
        return content.startswith(b"version https://git-lfs.github.com/spec/v1\n")

    @classmethod
    def _file_is_lfs_pointer(cls, path: Path) -> bool:
        with path.open("rb") as source:
            return cls._is_lfs_pointer(source.read(150))

    @staticmethod
    def _validate_download_url(url: str) -> None:
        parsed = urlparse(url)
        hostname = (parsed.hostname or "").lower()
        if parsed.scheme != "https" or not (
            hostname == "huggingface.co" or hostname.endswith(".hf.co")
        ):
            raise RuntimeError("The reranker download location is not trusted.")

    @staticmethod
    def _atomic_write(destination: Path, content: bytes) -> None:
        partial = destination.with_suffix(destination.suffix + ".part")
        partial.write_bytes(content)
        os.replace(partial, destination)

    @staticmethod
    def _peak_memory_bytes() -> int:
        usage = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return int(usage if sys.platform == "darwin" else usage * 1024)

    def rerank(
        self, question: str, chunks: list[dict[str, Any]], limit: int
    ) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        if not chunks:
            return [], {"rerankerApplied": False, "rerankLatencyMs": 0.0}
        memory_before_load = self._peak_memory_bytes()
        try:
            self._load()
        except Exception:
            return chunks[:limit], {
                "rerankerApplied": False,
                "rerankerAvailable": False,
                "rerankLatencyMs": 0.0,
            }
        import torch

        started = time.perf_counter()
        scores: list[float] = []
        batch_size = 4
        candidates = chunks[: self.MAX_CANDIDATES]
        pairs = [
            (
                question,
                "\n".join(
                    part
                    for part in [
                        str(chunk.get("file_name") or ""),
                        str(chunk.get("heading") or ""),
                        str(chunk.get("text") or ""),
                    ]
                    if part
                ),
            )
            for chunk in candidates
        ]
        with torch.inference_mode():
            for offset in range(0, len(pairs), batch_size):
                batch = pairs[offset : offset + batch_size]
                encoded = self._tokenizer(
                    batch,
                    padding=True,
                    truncation=True,
                    max_length=512,
                    return_tensors="pt",
                )
                encoded = {key: value.to(self._device) for key, value in encoded.items()}
                logits = self._model(**encoded).logits.reshape(-1)
                scores.extend(
                    1.0 / (1.0 + math.exp(-max(-30.0, min(30.0, float(value)))))
                    for value in logits.float().cpu()
                )

        ranked = [
            {**chunk, "_reranker_score": score}
            for chunk, score in sorted(
                zip(candidates, scores, strict=True), key=lambda item: item[1], reverse=True
            )
        ]
        process_peak = self._peak_memory_bytes()
        return ranked[:limit], {
            "rerankerApplied": True,
            "rerankLatencyMs": round((time.perf_counter() - started) * 1000, 2),
            "rerankerPeakMemoryBytes": max(0, process_peak - memory_before_load),
            "processPeakMemoryBytes": process_peak,
        }

    def unload(self) -> None:
        if self._model is None:
            return
        self._model = None
        self._tokenizer = None
        try:
            import torch

            if self._device == "mps" and hasattr(torch, "mps"):
                torch.mps.empty_cache()
        except Exception:
            pass
