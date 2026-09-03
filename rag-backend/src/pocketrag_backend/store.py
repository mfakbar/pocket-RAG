from __future__ import annotations

import json
import re
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

import lancedb
import pyarrow as pa
from lancedb.rerankers import LinearCombinationReranker


def _sql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


class HybridStore:
    TABLE = "chunks_v2"
    DOCUMENTS_TABLE = "documents_v2"
    SPREADSHEET_CELLS_TABLE = "spreadsheet_cells_v1"
    DOCUMENT_METADATA_TABLE = "document_metadata_v1"
    SECTION_SUMMARIES_TABLE = "section_summaries_v1"

    def __init__(self, data_dir: str) -> None:
        self.root = Path(data_dir)
        self.root.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(self.root / "state.sqlite")
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.execute(
            "CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.DOCUMENTS_TABLE} (
              knowledge_base_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              document_id TEXT NOT NULL,
              version_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              PRIMARY KEY (knowledge_base_id, generation, document_id)
            )
            """
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.SPREADSHEET_CELLS_TABLE} (
              knowledge_base_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              document_id TEXT NOT NULL,
              version_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              file_name TEXT NOT NULL,
              sheet_name TEXT NOT NULL,
              row_index INTEGER NOT NULL,
              column_index INTEGER NOT NULL,
              column_name TEXT NOT NULL,
              cell_address TEXT NOT NULL,
              display_value TEXT NOT NULL,
              raw_value TEXT NOT NULL,
              value_type TEXT NOT NULL,
              numeric_value REAL,
              unit TEXT NOT NULL,
              formula TEXT NOT NULL,
              PRIMARY KEY (
                knowledge_base_id, generation, document_id, version_id,
                sheet_name, row_index, column_index
              )
            )
            """
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.DOCUMENT_METADATA_TABLE} (
              knowledge_base_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              document_id TEXT NOT NULL,
              version_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              file_name TEXT NOT NULL,
              title TEXT NOT NULL,
              extension TEXT NOT NULL,
              path_segments TEXT NOT NULL,
              headings TEXT NOT NULL,
              entities TEXT NOT NULL,
              summary TEXT NOT NULL,
              PRIMARY KEY (knowledge_base_id, generation, document_id, version_id)
            )
            """
        )
        self.connection.execute(
            f"""
            CREATE TABLE IF NOT EXISTS {self.SECTION_SUMMARIES_TABLE} (
              knowledge_base_id TEXT NOT NULL,
              generation TEXT NOT NULL,
              document_id TEXT NOT NULL,
              version_id TEXT NOT NULL,
              relative_path TEXT NOT NULL,
              file_name TEXT NOT NULL,
              section_index INTEGER NOT NULL,
              heading TEXT NOT NULL,
              location TEXT NOT NULL,
              summary TEXT NOT NULL,
              PRIMARY KEY (
                knowledge_base_id, generation, document_id, version_id, section_index
              )
            )
            """
        )
        self.connection.execute(
            f"CREATE INDEX IF NOT EXISTS spreadsheet_cells_active_idx ON {self.SPREADSHEET_CELLS_TABLE} "
            "(knowledge_base_id, generation, document_id, version_id, file_name, sheet_name)"
        )
        self.connection.execute(
            f"CREATE INDEX IF NOT EXISTS spreadsheet_cells_column_idx ON {self.SPREADSHEET_CELLS_TABLE} "
            "(column_name, numeric_value)"
        )
        self.connection.commit()
        self.database = lancedb.connect(self.root / "lancedb")

    def close(self) -> None:
        connection = getattr(self, "connection", None)
        if connection is not None:
            connection.close()
            self.connection = None

    def _generation_key(self, knowledge_base_id: str) -> str:
        return f"active_generation:{knowledge_base_id}"

    def _active_generation(self, knowledge_base_id: str) -> str:
        row = self.connection.execute(
            "SELECT value FROM metadata WHERE key = ?",
            (self._generation_key(knowledge_base_id),),
        ).fetchone()
        return str(row[0]) if row else "default"

    def active_generation(self, knowledge_base_id: str) -> str:
        return self._active_generation(knowledge_base_id)

    def _table(self):
        names = self.database.list_tables().tables
        return self.database.open_table(self.TABLE) if self.TABLE in names else None

    def _delete_auxiliary(
        self,
        where: str,
        values: tuple[Any, ...],
    ) -> None:
        for table in (
            self.SPREADSHEET_CELLS_TABLE,
            self.DOCUMENT_METADATA_TABLE,
            self.SECTION_SUMMARIES_TABLE,
        ):
            self.connection.execute(f"DELETE FROM {table} WHERE {where}", values)

    def _ensure_table(self, vector_size: int):
        table = self._table()
        if table is not None:
            vector_field = table.schema.field("vector").type
            if getattr(vector_field, "list_size", vector_size) != vector_size:
                raise RuntimeError("The embedding model size changed. Rebuild the document index.")
            return table
        schema = pa.schema(
            [
                pa.field("id", pa.string()),
                pa.field("knowledge_base_id", pa.string()),
                pa.field("generation", pa.string()),
                pa.field("document_id", pa.string()),
                pa.field("version_id", pa.string()),
                pa.field("relative_path", pa.string()),
                pa.field("file_name", pa.string()),
                pa.field("extension", pa.string()),
                pa.field("chunk_index", pa.int32()),
                pa.field("text", pa.string()),
                pa.field("embedding_text", pa.string()),
                pa.field("location", pa.string()),
                pa.field("heading", pa.string()),
                pa.field("vector", pa.list_(pa.float32(), vector_size)),
            ]
        )
        return self.database.create_table(self.TABLE, schema=schema)

    def health(self) -> dict[str, Any]:
        documents = self.connection.execute(
            f"SELECT COUNT(*) FROM {self.DOCUMENTS_TABLE}"
        ).fetchone()[0]
        table = self._table()
        return {
            "ready": True,
            "generation": "multiple",
            "documents": int(documents),
            "chunks": int(table.count_rows()) if table is not None else 0,
        }

    def reset_index(self) -> None:
        if self._table() is not None:
            self.database.drop_table(self.TABLE)
        with self.connection:
            for table in (
                self.DOCUMENTS_TABLE,
                self.SPREADSHEET_CELLS_TABLE,
                self.DOCUMENT_METADATA_TABLE,
                self.SECTION_SUMMARIES_TABLE,
            ):
                self.connection.execute(f"DELETE FROM {table}")
            self.connection.execute(
                "DELETE FROM metadata WHERE key LIKE 'active_generation:%'"
            )

    def begin_rebuild(self, _knowledge_base_id: str) -> str:
        return str(uuid4())

    def has_document_version(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
    ) -> bool:
        row = self.connection.execute(
            f"SELECT 1 FROM {self.DOCUMENTS_TABLE} "
            "WHERE knowledge_base_id = ? AND generation = ? "
            "AND document_id = ? AND version_id = ?",
            (knowledge_base_id, generation, document_id, version_id),
        ).fetchone()
        return row is not None

    def clone_active_document(
        self,
        knowledge_base_id: str,
        generation: str,
        source_document_id: str,
        target_document_id: str,
        target_version_id: str,
        target_relative_path: str,
    ) -> bool:
        source_generation = self._active_generation(knowledge_base_id)
        source = self.connection.execute(
            f"SELECT version_id FROM {self.DOCUMENTS_TABLE} "
            "WHERE knowledge_base_id = ? AND generation = ? AND document_id = ?",
            (knowledge_base_id, source_generation, source_document_id),
        ).fetchone()
        if source is None:
            return False
        if self.has_document_version(
            knowledge_base_id, generation, target_document_id, target_version_id
        ):
            return True

        source_version_id = str(source[0])
        table = self._table()
        if table is None:
            return False
        source_filter = (
            f"knowledge_base_id = {_sql(knowledge_base_id)} "
            f"AND generation = {_sql(source_generation)} "
            f"AND document_id = {_sql(source_document_id)} "
            f"AND version_id = {_sql(source_version_id)}"
        )
        source_row_count = table.count_rows(source_filter)
        if source_row_count == 0:
            return False
        target_file_name = Path(target_relative_path).name
        batch_size = 512
        for offset in range(0, source_row_count, batch_size):
            source_rows = (
                table.search()
                .where(source_filter)
                .offset(offset)
                .limit(batch_size)
                .to_list()
            )
            cloned_rows = []
            for source_row in source_rows:
                row = {
                    key: value
                    for key, value in source_row.items()
                    if not str(key).startswith("_")
                }
                row.update(
                    {
                        "id": str(uuid4()),
                        "generation": generation,
                        "document_id": target_document_id,
                        "version_id": target_version_id,
                        "relative_path": target_relative_path,
                        "file_name": target_file_name,
                    }
                )
                cloned_rows.append(row)
            self.append_document_rows(cloned_rows)

        with self.connection:
            self.connection.execute(
                f"""
                INSERT OR REPLACE INTO {self.DOCUMENTS_TABLE}
                  (knowledge_base_id, generation, document_id, version_id, relative_path)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    knowledge_base_id,
                    generation,
                    target_document_id,
                    target_version_id,
                    target_relative_path,
                ),
            )
            for table_name in (
                self.SPREADSHEET_CELLS_TABLE,
                self.DOCUMENT_METADATA_TABLE,
                self.SECTION_SUMMARIES_TABLE,
            ):
                columns = [
                    str(row[1])
                    for row in self.connection.execute(f"PRAGMA table_info({table_name})")
                ]
                selected = []
                for column in columns:
                    if column == "generation":
                        selected.append("?")
                    elif column == "document_id":
                        selected.append("?")
                    elif column == "version_id":
                        selected.append("?")
                    elif column == "relative_path":
                        selected.append("?")
                    elif column == "file_name":
                        selected.append("?")
                    else:
                        selected.append(column)
                self.connection.execute(
                    f"INSERT OR REPLACE INTO {table_name} ({', '.join(columns)}) "
                    f"SELECT {', '.join(selected)} FROM {table_name} "
                    "WHERE knowledge_base_id = ? AND generation = ? "
                    "AND document_id = ? AND version_id = ?",
                    (
                        generation,
                        target_document_id,
                        target_version_id,
                        target_relative_path,
                        target_file_name,
                        knowledge_base_id,
                        source_generation,
                        source_document_id,
                        source_version_id,
                    ),
                )
        return True

    def prune_generation(
        self, knowledge_base_id: str, generation: str, allowed_document_ids: list[str]
    ) -> None:
        allowed = set(allowed_document_ids)
        rows = self.connection.execute(
            f"SELECT document_id FROM {self.DOCUMENTS_TABLE} "
            "WHERE knowledge_base_id = ? AND generation = ?",
            (knowledge_base_id, generation),
        ).fetchall()
        for (document_id,) in rows:
            if str(document_id) not in allowed:
                self.remove_document(knowledge_base_id, str(document_id), generation)

    def commit_rebuild(self, knowledge_base_id: str, generation: str) -> None:
        with self.connection:
            self.connection.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES(?, ?)",
                (self._generation_key(knowledge_base_id), generation),
            )
            self.connection.execute(
                f"DELETE FROM {self.DOCUMENTS_TABLE} "
                "WHERE knowledge_base_id = ? AND generation != ?",
                (knowledge_base_id, generation),
            )
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation != ?",
                (knowledge_base_id, generation),
            )
        table = self._table()
        if table is not None:
            table.delete(
                f"knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation != {_sql(generation)}"
            )

    def abort_rebuild(self, knowledge_base_id: str, generation: str) -> None:
        if generation == self._active_generation(knowledge_base_id):
            return
        with self.connection:
            self.connection.execute(
                f"DELETE FROM {self.DOCUMENTS_TABLE} "
                "WHERE knowledge_base_id = ? AND generation = ?",
                (knowledge_base_id, generation),
            )
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation = ?",
                (knowledge_base_id, generation),
            )
        table = self._table()
        if table is not None:
            table.delete(
                f"knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation = {_sql(generation)}"
            )

    def index_document(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
        relative_path: str,
        rows: list[dict[str, Any]],
    ) -> None:
        if not rows:
            raise RuntimeError("No readable text was found in this document.")
        self.prepare_document_version(
            knowledge_base_id, generation, document_id, version_id
        )
        self.append_document_rows(rows)
        self.commit_document_version(
            knowledge_base_id,
            generation,
            document_id,
            version_id,
            relative_path,
        )

    def prepare_document_version(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
    ) -> None:
        active = self.connection.execute(
            f"SELECT version_id FROM {self.DOCUMENTS_TABLE} "
            "WHERE knowledge_base_id = ? AND generation = ? AND document_id = ?",
            (knowledge_base_id, generation, document_id),
        ).fetchone()
        if active and str(active[0]) == version_id:
            return
        table = self._table()
        if table is not None:
            table.delete(
                f"knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation = {_sql(generation)} "
                f"AND document_id = {_sql(document_id)} "
                f"AND version_id = {_sql(version_id)}"
            )
        with self.connection:
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation = ? AND document_id = ? AND version_id = ?",
                (knowledge_base_id, generation, document_id, version_id),
            )

    def append_document_rows(self, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        self._ensure_table(len(rows[0]["vector"])).add(rows)

    def stage_spreadsheet_cells(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
        relative_path: str,
        cells: list[dict[str, Any]],
    ) -> None:
        if not cells:
            return
        file_name = Path(relative_path).name
        rows = [
            (
                knowledge_base_id,
                generation,
                document_id,
                version_id,
                relative_path,
                file_name,
                str(cell.get("sheet_name") or ""),
                int(cell["row_index"]),
                int(cell["column_index"]),
                str(cell.get("column_name") or ""),
                str(cell.get("cell_address") or ""),
                str(cell.get("display_value") or ""),
                str(cell.get("raw_value") or ""),
                str(cell.get("value_type") or ""),
                cell.get("numeric_value"),
                str(cell.get("unit") or ""),
                str(cell.get("formula") or ""),
            )
            for cell in cells
        ]
        with self.connection:
            self.connection.executemany(
                f"""
                INSERT OR REPLACE INTO {self.SPREADSHEET_CELLS_TABLE} (
                  knowledge_base_id, generation, document_id, version_id,
                  relative_path, file_name, sheet_name, row_index, column_index,
                  column_name, cell_address, display_value, raw_value, value_type,
                  numeric_value, unit, formula
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                rows,
            )

    def stage_document_metadata(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
        relative_path: str,
        metadata: dict[str, Any],
    ) -> None:
        file_name = Path(relative_path).name
        with self.connection:
            self.connection.execute(
                f"""
                INSERT OR REPLACE INTO {self.DOCUMENT_METADATA_TABLE} (
                  knowledge_base_id, generation, document_id, version_id,
                  relative_path, file_name, title, extension, path_segments,
                  headings, entities, summary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    knowledge_base_id,
                    generation,
                    document_id,
                    version_id,
                    relative_path,
                    file_name,
                    str(metadata.get("title") or ""),
                    str(metadata.get("extension") or ""),
                    json.dumps(metadata.get("pathSegments") or [], ensure_ascii=False),
                    json.dumps(metadata.get("headings") or [], ensure_ascii=False),
                    json.dumps(metadata.get("entities") or [], ensure_ascii=False),
                    str(metadata.get("summary") or ""),
                ),
            )
            sections = list(metadata.get("sections") or [])
            self.connection.executemany(
                f"""
                INSERT OR REPLACE INTO {self.SECTION_SUMMARIES_TABLE} (
                  knowledge_base_id, generation, document_id, version_id,
                  relative_path, file_name, section_index, heading, location, summary
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        knowledge_base_id,
                        generation,
                        document_id,
                        version_id,
                        relative_path,
                        file_name,
                        index,
                        str(section.get("heading") or ""),
                        str(section.get("location") or ""),
                        str(section.get("summary") or ""),
                    )
                    for index, section in enumerate(sections)
                ],
            )

    def commit_document_version(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
        relative_path: str,
    ) -> None:
        table = self._table()
        if table is None:
            raise RuntimeError("No document chunks were staged for indexing.")
        with self.connection:
            self.connection.execute(
                f"""
                INSERT OR REPLACE INTO {self.DOCUMENTS_TABLE}
                  (knowledge_base_id, generation, document_id, version_id, relative_path)
                VALUES(?, ?, ?, ?, ?)
                """,
                (knowledge_base_id, generation, document_id, version_id, relative_path),
            )
        table.delete(
            f"knowledge_base_id = {_sql(knowledge_base_id)} "
            f"AND generation = {_sql(generation)} "
            f"AND document_id = {_sql(document_id)} "
            f"AND version_id != {_sql(version_id)}"
        )
        with self.connection:
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation = ? AND document_id = ? AND version_id != ?",
                (knowledge_base_id, generation, document_id, version_id),
            )

    def abort_document_version(
        self,
        knowledge_base_id: str,
        generation: str,
        document_id: str,
        version_id: str,
    ) -> None:
        active = self.connection.execute(
            f"SELECT version_id FROM {self.DOCUMENTS_TABLE} "
            "WHERE knowledge_base_id = ? AND generation = ? AND document_id = ?",
            (knowledge_base_id, generation, document_id),
        ).fetchone()
        if active and str(active[0]) == version_id:
            return
        table = self._table()
        if table is not None:
            table.delete(
                f"knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation = {_sql(generation)} "
                f"AND document_id = {_sql(document_id)} "
                f"AND version_id = {_sql(version_id)}"
            )
        with self.connection:
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation = ? AND document_id = ? AND version_id = ?",
                (knowledge_base_id, generation, document_id, version_id),
            )

    def remove_document(
        self, knowledge_base_id: str, document_id: str, generation: str | None = None
    ) -> None:
        target = generation or self._active_generation(knowledge_base_id)
        with self.connection:
            self.connection.execute(
                f"DELETE FROM {self.DOCUMENTS_TABLE} "
                "WHERE knowledge_base_id = ? AND generation = ? AND document_id = ?",
                (knowledge_base_id, target, document_id),
            )
            self._delete_auxiliary(
                "knowledge_base_id = ? AND generation = ? AND document_id = ?",
                (knowledge_base_id, target, document_id),
            )
        table = self._table()
        if table is not None:
            table.delete(
                f"knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation = {_sql(target)} AND document_id = {_sql(document_id)}"
            )

    def finalize(self) -> None:
        table = self._table()
        if table is not None and table.count_rows() > 0:
            table.create_fts_index("embedding_text", replace=True, use_tantivy=False)

    def clear(self, knowledge_base_id: str | None = None) -> None:
        if knowledge_base_id is None:
            if self.TABLE in self.database.list_tables().tables:
                self.database.drop_table(self.TABLE)
            with self.connection:
                self.connection.execute(f"DELETE FROM {self.DOCUMENTS_TABLE}")
                for auxiliary in (
                    self.SPREADSHEET_CELLS_TABLE,
                    self.DOCUMENT_METADATA_TABLE,
                    self.SECTION_SUMMARIES_TABLE,
                ):
                    self.connection.execute(f"DELETE FROM {auxiliary}")
                self.connection.execute(
                    "DELETE FROM metadata WHERE key LIKE 'active_generation:%'"
                )
            return
        table = self._table()
        if table is not None:
            table.delete(f"knowledge_base_id = {_sql(knowledge_base_id)}")
        with self.connection:
            self.connection.execute(
                f"DELETE FROM {self.DOCUMENTS_TABLE} WHERE knowledge_base_id = ?",
                (knowledge_base_id,),
            )
            self._delete_auxiliary("knowledge_base_id = ?", (knowledge_base_id,))
            self.connection.execute(
                "DELETE FROM metadata WHERE key = ?",
                (self._generation_key(knowledge_base_id),),
            )

    def _active_filter(self, knowledge_base_ids: list[str]) -> str:
        clauses: list[str] = []
        for knowledge_base_id in knowledge_base_ids:
            generation = self._active_generation(knowledge_base_id)
            rows = self.connection.execute(
                f"SELECT document_id, version_id FROM {self.DOCUMENTS_TABLE} "
                "WHERE knowledge_base_id = ? AND generation = ?",
                (knowledge_base_id, generation),
            ).fetchall()
            clauses.extend(
                f"(knowledge_base_id = {_sql(knowledge_base_id)} "
                f"AND generation = {_sql(generation)} "
                f"AND document_id = {_sql(str(document_id))} "
                f"AND version_id = {_sql(str(version_id))})"
                for document_id, version_id in rows
            )
        return f"({' OR '.join(clauses)})" if clauses else "false"

    def sample(self, knowledge_base_ids: list[str], limit: int = 8) -> list[dict[str, Any]]:
        table = self._table()
        active_filter = self._active_filter(knowledge_base_ids)
        if table is None or active_filter == "false":
            return []
        rows = table.search().where(active_filter).limit(max(limit * 4, 20)).to_list()
        selected: list[dict[str, Any]] = []
        seen_documents: set[str] = set()
        for row in rows:
            key = f"{row['knowledge_base_id']}:{row['document_id']}"
            if key in seen_documents and len(seen_documents) < limit:
                continue
            seen_documents.add(key)
            selected.append(row)
            if len(selected) >= limit:
                break
        return selected

    def active_file_names(self, knowledge_base_ids: list[str]) -> list[str]:
        names: set[str] = set()
        for knowledge_base_id in knowledge_base_ids:
            generation = self._active_generation(knowledge_base_id)
            rows = self.connection.execute(
                f"SELECT relative_path FROM {self.DOCUMENTS_TABLE} "
                "WHERE knowledge_base_id = ? AND generation = ?",
                (knowledge_base_id, generation),
            ).fetchall()
            names.update(Path(str(row[0])).name for row in rows)
        return sorted(names, key=str.casefold)

    def active_source_catalog(self, knowledge_base_ids: list[str]) -> list[dict[str, Any]]:
        """Return filterable document metadata for deterministic source resolution."""
        catalog: list[dict[str, Any]] = []
        for knowledge_base_id in knowledge_base_ids:
            generation = self._active_generation(knowledge_base_id)
            documents = self.connection.execute(
                f"""
                SELECT d.knowledge_base_id, d.document_id, d.relative_path,
                       COALESCE(m.file_name, ''), COALESCE(m.title, ''),
                       COALESCE(m.path_segments, ''), COALESCE(m.headings, ''),
                       COALESCE(m.entities, ''), COALESCE(m.summary, '')
                FROM {self.DOCUMENTS_TABLE} d
                LEFT JOIN {self.DOCUMENT_METADATA_TABLE} m
                  ON m.knowledge_base_id = d.knowledge_base_id
                 AND m.generation = d.generation
                 AND m.document_id = d.document_id
                 AND m.version_id = d.version_id
                WHERE d.knowledge_base_id = ? AND d.generation = ?
                """,
                (knowledge_base_id, generation),
            ).fetchall()
            sheet_rows = self.connection.execute(
                f"""
                SELECT document_id, sheet_name
                FROM {self.SPREADSHEET_CELLS_TABLE}
                WHERE knowledge_base_id = ? AND generation = ?
                GROUP BY document_id, sheet_name
                ORDER BY document_id, sheet_name
                """,
                (knowledge_base_id, generation),
            ).fetchall()
            sheets: dict[str, list[str]] = {}
            for document_id, sheet_name in sheet_rows:
                sheets.setdefault(str(document_id), []).append(str(sheet_name))
            for row in documents:
                relative_path = str(row[2])
                file_name = str(row[3]) or Path(relative_path).name
                catalog.append(
                    {
                        "knowledgeBaseId": str(row[0]),
                        "documentId": str(row[1]),
                        "path": relative_path,
                        "file": file_name,
                        "title": str(row[4]),
                        "pathSegments": str(row[5]),
                        "headings": str(row[6]),
                        "entities": str(row[7]),
                        "summary": str(row[8]),
                        "sheets": sheets.get(str(row[1]), []),
                    }
                )
        return sorted(catalog, key=lambda item: str(item["file"]).casefold())

    @staticmethod
    def _query_terms(value: str) -> set[str]:
        stop = {"and", "are", "for", "from", "the", "this", "what", "which", "with"}
        return {
            term
            for term in re.findall(r"[a-z0-9._/-]{3,}", value.casefold())
            if term not in stop
        }

    def structured_rows(
        self,
        knowledge_base_ids: list[str],
        question: str,
        file_names: list[str] | None = None,
        sheet_names: list[str] | None = None,
        limit: int = 240,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        for knowledge_base_id in knowledge_base_ids:
            clauses.append("(c.knowledge_base_id = ? AND c.generation = ?)")
            values.extend([knowledge_base_id, self._active_generation(knowledge_base_id)])
        if not clauses:
            return []
        file_clause = ""
        if file_names:
            placeholders = ", ".join("?" for _ in file_names)
            file_clause = f" AND c.file_name IN ({placeholders})"
            values.extend(file_names)
        sheet_clause = ""
        if sheet_names:
            placeholders = ", ".join("?" for _ in sheet_names)
            sheet_clause = f" AND c.sheet_name IN ({placeholders})"
            values.extend(sheet_names)
        rows = self.connection.execute(
            f"""
            SELECT c.knowledge_base_id, c.document_id, c.relative_path, c.file_name,
                   c.sheet_name, c.row_index, c.column_index, c.column_name,
                   c.cell_address, c.display_value, c.raw_value, c.value_type,
                   c.numeric_value, c.unit, c.formula
            FROM {self.SPREADSHEET_CELLS_TABLE} c
            JOIN {self.DOCUMENTS_TABLE} d
              ON d.knowledge_base_id = c.knowledge_base_id
             AND d.generation = c.generation
             AND d.document_id = c.document_id
             AND d.version_id = c.version_id
            WHERE ({' OR '.join(clauses)}){file_clause}{sheet_clause}
            ORDER BY c.file_name, c.sheet_name, c.row_index, c.column_index
            """,
            tuple(values),
        ).fetchall()
        grouped: dict[tuple[str, str, int], dict[str, Any]] = {}
        for row in rows:
            key = (str(row[3]), str(row[4]), int(row[5]))
            item = grouped.setdefault(
                key,
                {
                    "knowledgeBaseId": str(row[0]),
                    "documentId": str(row[1]),
                    "path": str(row[2]),
                    "file": str(row[3]),
                    "sheet": str(row[4]),
                    "rowIndex": int(row[5]),
                    "cells": [],
                },
            )
            item["cells"].append(
                {
                    "columnIndex": int(row[6]),
                    "column": str(row[7]),
                    "address": str(row[8]),
                    "value": str(row[9]),
                    "rawValue": str(row[10]),
                    "valueType": str(row[11]),
                    "numericValue": float(row[12]) if row[12] is not None else None,
                    "unit": str(row[13]),
                    "formula": str(row[14]),
                }
            )
        query_terms = self._query_terms(question)
        ranked = list(grouped.values())
        for item in ranked:
            searchable = " ".join(
                [
                    item["file"],
                    item["sheet"],
                    *(
                        f"{cell['column']} {cell['value']}"
                        for cell in item["cells"]
                    ),
                ]
            ).casefold()
            item["score"] = sum(1 for term in query_terms if term in searchable)
        ranked.sort(
            key=lambda item: (-int(item["score"]), item["file"], item["sheet"], item["rowIndex"])
        )
        relevant = [item for item in ranked if item["score"] > 0]
        return (relevant or ranked)[: max(1, limit)]

    def hierarchical_summaries(
        self,
        knowledge_base_ids: list[str],
        question: str,
        file_names: list[str] | None = None,
        sheet_names: list[str] | None = None,
        limit: int = 10,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        for knowledge_base_id in knowledge_base_ids:
            clauses.append("(s.knowledge_base_id = ? AND s.generation = ?)")
            values.extend([knowledge_base_id, self._active_generation(knowledge_base_id)])
        if not clauses:
            return []
        file_clause = ""
        if file_names:
            placeholders = ", ".join("?" for _ in file_names)
            file_clause = f" AND s.file_name IN ({placeholders})"
            values.extend(file_names)
        sheet_clause = ""
        if sheet_names:
            sheet_parts: list[str] = []
            for sheet_name in sheet_names:
                sheet_parts.append("(s.heading = ? OR s.location LIKE ?)")
                values.extend([sheet_name, f"Sheet {sheet_name},%"])
            sheet_clause = f" AND ({' OR '.join(sheet_parts)})"
        rows = self.connection.execute(
            f"""
            SELECT s.knowledge_base_id, s.document_id, s.relative_path, s.file_name,
                   s.heading, s.location, s.summary
            FROM {self.SECTION_SUMMARIES_TABLE} s
            JOIN {self.DOCUMENTS_TABLE} d
              ON d.knowledge_base_id = s.knowledge_base_id
             AND d.generation = s.generation
             AND d.document_id = s.document_id
             AND d.version_id = s.version_id
            WHERE ({' OR '.join(clauses)}){file_clause}{sheet_clause}
            """,
            tuple(values),
        ).fetchall()
        query_terms = self._query_terms(question)
        summaries = [
            {
                "knowledgeBaseId": str(row[0]),
                "documentId": str(row[1]),
                "path": str(row[2]),
                "file": str(row[3]),
                "heading": str(row[4]),
                "location": str(row[5]),
                "summary": str(row[6]),
            }
            for row in rows
        ]
        for item in summaries:
            searchable = f"{item['file']} {item['heading']} {item['location']} {item['summary']}".casefold()
            item["score"] = sum(1 for term in query_terms if term in searchable)
        summaries.sort(key=lambda item: (-int(item["score"]), item["file"], item["location"]))
        return summaries[: max(1, limit)]

    def metadata_matching_files(
        self,
        knowledge_base_ids: list[str],
        question: str,
        limit: int = 8,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        values: list[Any] = []
        for knowledge_base_id in knowledge_base_ids:
            clauses.append("(m.knowledge_base_id = ? AND m.generation = ?)")
            values.extend([knowledge_base_id, self._active_generation(knowledge_base_id)])
        if not clauses:
            return []
        rows = self.connection.execute(
            f"""
            SELECT m.knowledge_base_id, m.document_id, m.file_name, m.title,
                   m.relative_path, m.headings, m.entities, m.summary
            FROM {self.DOCUMENT_METADATA_TABLE} m
            JOIN {self.DOCUMENTS_TABLE} d
              ON d.knowledge_base_id = m.knowledge_base_id
             AND d.generation = m.generation
             AND d.document_id = m.document_id
             AND d.version_id = m.version_id
            WHERE {' OR '.join(clauses)}
            """,
            tuple(values),
        ).fetchall()
        query_terms = self._query_terms(question)
        matches: list[dict[str, Any]] = []
        for row in rows:
            searchable = " ".join(str(value) for value in row[2:]).casefold()
            score = sum(1 for term in query_terms if term in searchable)
            if score <= 0:
                continue
            matches.append(
                {
                    "knowledgeBaseId": str(row[0]),
                    "documentId": str(row[1]),
                    "file": str(row[2]),
                    "score": score,
                }
            )
        matches.sort(key=lambda item: (-int(item["score"]), item["file"]))
        return matches[: max(1, limit)]

    def query(
        self,
        query: str,
        query_vector: list[float],
        top_k: int,
        candidate_limit: int,
        hybrid: bool,
        keyword_weight: float,
        full_context: bool,
        knowledge_base_ids: list[str],
        file_names: list[str] | None = None,
        sheet_names: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        table = self._table()
        if table is None:
            return []
        active_filter = self._active_filter(knowledge_base_ids)
        if active_filter == "false":
            return []
        search_filter = active_filter
        if file_names:
            file_filter = " OR ".join(
                f"file_name = {_sql(file_name)}" for file_name in file_names
            )
            search_filter = f"({active_filter}) AND ({file_filter})"
        if sheet_names:
            sheet_filter = " OR ".join(
                f"(heading = {_sql(sheet_name)} OR location LIKE {_sql(f'Sheet {sheet_name},%')})"
                for sheet_name in sheet_names
            )
            search_filter = f"({search_filter}) AND ({sheet_filter})"
        limit = max(top_k, candidate_limit)
        if hybrid:
            builder = (
                table.search(
                    query_type="hybrid",
                    vector_column_name="vector",
                    fts_columns="embedding_text",
                )
                .vector(query_vector)
                .text(query)
                .where(search_filter)
                .distance_type("cosine")
                .rerank(
                    LinearCombinationReranker(
                        weight=max(0.0, min(1.0, 1.0 - keyword_weight)),
                        return_score="all",
                    )
                )
                .limit(limit)
            )
        else:
            builder = (
                table.search(query_vector, vector_column_name="vector")
                .where(search_filter)
                .distance_type("cosine")
                .limit(limit)
            )
        results = builder.to_list()
        if not full_context or not results:
            return results
        document_ids = {
            (str(item["knowledge_base_id"]), str(item["document_id"])) for item in results[:top_k]
        }
        document_filter = " OR ".join(
            f"(knowledge_base_id = {_sql(knowledge_base_id)} "
            f"AND document_id = {_sql(document_id)})"
            for knowledge_base_id, document_id in sorted(document_ids)
        )
        expanded = (
            table.search()
            .where(f"({search_filter}) AND ({document_filter})")
            .limit(20_000)
            .to_list()
        )
        return sorted(
            expanded,
            key=lambda row: (
                str(row["knowledge_base_id"]),
                str(row["relative_path"]),
                int(row["chunk_index"]),
            ),
        )

    def expand_neighbors(
        self,
        seeds: list[dict[str, Any]],
        radius: int = 1,
        limit: int = 12,
    ) -> list[dict[str, Any]]:
        """Return each matched chunk with nearby chunks from the same document."""
        table = self._table()
        if table is None or not seeds or radius < 1:
            return seeds[:limit]

        documents = {
            (
                str(seed["knowledge_base_id"]),
                str(seed["generation"]),
                str(seed["document_id"]),
                str(seed["version_id"]),
            )
            for seed in seeds
        }
        document_filter = " OR ".join(
            "(knowledge_base_id = {kb} AND generation = {generation} "
            "AND document_id = {document} AND version_id = {version})".format(
                kb=_sql(knowledge_base_id),
                generation=_sql(generation),
                document=_sql(document_id),
                version=_sql(version_id),
            )
            for knowledge_base_id, generation, document_id, version_id in sorted(documents)
        )
        candidates = table.search().where(document_filter).limit(20_000).to_list()
        by_document: dict[tuple[str, str, str, str], dict[int, dict[str, Any]]] = {}
        for candidate in candidates:
            key = (
                str(candidate["knowledge_base_id"]),
                str(candidate["generation"]),
                str(candidate["document_id"]),
                str(candidate["version_id"]),
            )
            by_document.setdefault(key, {})[int(candidate["chunk_index"])] = candidate

        expanded: list[dict[str, Any]] = []
        seen: set[str] = set()
        for seed in seeds:
            key = (
                str(seed["knowledge_base_id"]),
                str(seed["generation"]),
                str(seed["document_id"]),
                str(seed["version_id"]),
            )
            seed_index = int(seed["chunk_index"])
            nearby = by_document.get(key, {})
            for index in range(seed_index - radius, seed_index + radius + 1):
                candidate = seed if index == seed_index else nearby.get(index)
                if candidate is None:
                    continue
                identifier = str(candidate["id"])
                if identifier in seen:
                    continue
                seen.add(identifier)
                if candidate is not seed:
                    candidate = dict(candidate)
                    seed_score = seed.get("_reranker_score", seed.get("_relevance_score"))
                    if seed_score is None and seed.get("_distance") is not None:
                        seed_score = 1.0 - float(seed["_distance"])
                    candidate["_relevance_score"] = max(0.0, float(seed_score or 0.0) - 0.02)
                expanded.append(candidate)
                if len(expanded) >= limit:
                    return expanded
        return expanded
