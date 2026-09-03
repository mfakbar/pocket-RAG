from __future__ import annotations

import json
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

from pocketrag_backend.ollama import OllamaEmbeddingClient


class OllamaEmbeddingClientTests(unittest.TestCase):
    @patch("pocketrag_backend.ollama.time.sleep")
    @patch("pocketrag_backend.ollama.urlopen")
    def test_retries_transient_server_error(self, urlopen: MagicMock, sleep: MagicMock) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps({"embeddings": [[0.1, 0.2]]}).encode()
        server_error = HTTPError("http://localhost", 500, "error", None, None)
        urlopen.side_effect = [server_error, response]

        client = OllamaEmbeddingClient("http://127.0.0.1:11434", "embedding-model")

        self.assertEqual(client.embed(["hello"]), [[0.1, 0.2]])
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)
        server_error.close()

    @patch("pocketrag_backend.ollama.time.sleep")
    @patch("pocketrag_backend.ollama.urlopen")
    def test_does_not_retry_client_error(self, urlopen: MagicMock, sleep: MagicMock) -> None:
        client_error = HTTPError("http://localhost", 400, "bad request", None, None)
        urlopen.side_effect = client_error
        client = OllamaEmbeddingClient("http://127.0.0.1:11434", "embedding-model")

        with self.assertRaisesRegex(RuntimeError, "after 3 attempts"):
            client.embed(["hello"])

        self.assertEqual(urlopen.call_count, 1)
        sleep.assert_not_called()
        client_error.close()

    @patch("pocketrag_backend.ollama.urlopen")
    def test_can_release_embedding_model_after_query(self, urlopen: MagicMock) -> None:
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(
            {"embeddings": [[0.1, 0.2]]}
        ).encode()
        urlopen.return_value = response
        client = OllamaEmbeddingClient("http://127.0.0.1:11434", "embedding-model")

        self.assertEqual(client.embed(["hello"], keep_alive=0), [[0.1, 0.2]])
        payload = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(payload["keep_alive"], 0)

    @patch("pocketrag_backend.ollama.urlopen")
    def test_unload_is_best_effort(self, urlopen: MagicMock) -> None:
        response = MagicMock()
        urlopen.return_value = response
        client = OllamaEmbeddingClient("http://127.0.0.1:11434", "embedding-model")

        client.unload()

        payload = json.loads(urlopen.call_args.args[0].data.decode("utf-8"))
        self.assertEqual(payload, {"model": "embedding-model", "keep_alive": 0})


if __name__ == "__main__":
    unittest.main()
