from __future__ import annotations

import json
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class OllamaEmbeddingClient:
    def __init__(self, base_url: str, model: str) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model

    def embed(
        self,
        texts: list[str],
        batch_size: int = 16,
        keep_alive: str | int | None = None,
    ) -> list[list[float]]:
        vectors: list[list[float]] = []
        for index in range(0, len(texts), batch_size):
            batch = texts[index : index + batch_size]
            body: dict[str, object] | None = None
            last_error: Exception | None = None
            for attempt in range(3):
                payload: dict[str, object] = {"model": self.model, "input": batch}
                if keep_alive is not None:
                    payload["keep_alive"] = keep_alive
                request = Request(
                    f"{self.base_url}/api/embed",
                    data=json.dumps(payload).encode("utf-8"),
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    with urlopen(request, timeout=300) as response:
                        body = json.loads(response.read().decode("utf-8"))
                    break
                except (HTTPError, URLError, TimeoutError) as error:
                    last_error = error
                    if attempt < 2 and (not isinstance(error, HTTPError) or error.code >= 500):
                        time.sleep(attempt + 1)
                        continue
                    break
            if body is None:
                raise RuntimeError(f"Local embedding failed after 3 attempts: {last_error}") from last_error
            embeddings = body.get("embeddings")
            if not isinstance(embeddings, list) or len(embeddings) != len(batch):
                raise RuntimeError("The embedding model returned an invalid response.")
            vectors.extend([[float(value) for value in vector] for vector in embeddings])
        return vectors

    def unload(self) -> None:
        request = Request(
            f"{self.base_url}/api/generate",
            data=json.dumps({"model": self.model, "keep_alive": 0}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urlopen(request, timeout=30):
                pass
        except (HTTPError, URLError, TimeoutError):
            # Releasing idle memory is best-effort and must not fail a completed sync.
            pass
