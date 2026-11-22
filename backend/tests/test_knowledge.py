"""Библиотека знаний: папки, загрузка, дедуп, нарезка, поиск, теги, граф, вложения."""

from __future__ import annotations

import asyncio
import io
import uuid

import pytest
from fastapi.testclient import TestClient

from app.core.config import settings
from app.services.knowledge import chunking, extract, storage
from app.services.knowledge import index as knowledge_index
from app.services.knowledge import store as knowledge_store

PREFIX = "/api/v1/knowledge"

_TEXT = (
    "Микросостояния ЭЭГ\n\n"
    "Микросостояния описывают квазистабильные топографии коры длительностью 60-120 мс.\n"
    "Классические классы A, B, C и D связаны с сетями покоя.\n\n"
    "Клиническое применение\n\n"
    "При депрессии меняется длительность класса C и переходные вероятности.\n"
)


async def _no_embeddings(texts: list[str], *, client=None) -> None:
    """Эмбеддинги в тестах отключены: никаких внешних вызовов провайдера."""
    return None


@pytest.fixture(autouse=True)
def isolated_library(tmp_path, monkeypatch):
    """Библиотека в tmp и без сети: тесты не трогают data/ и провайдера."""
    monkeypatch.setattr(settings, "knowledge_dir", str(tmp_path / "knowledge"))
    monkeypatch.setattr(settings, "knowledge_max_file_mb", 1)
    monkeypatch.setattr(settings, "knowledge_max_total_mb", 4)
    monkeypatch.setattr(knowledge_index, "embed_texts", _no_embeddings)
    yield


@pytest.fixture
def folder(client: TestClient) -> str:
    """Своя папка на тест: БД общая на сессию, счётчики считаются по папке."""
    response = client.post(f"{PREFIX}/folders", json={"name": f"Тест {uuid.uuid4().hex[:8]}"})
    assert response.status_code == 201
    return response.json()["id"]


def _upload(
    client: TestClient,
    name: str,
    body: bytes,
    *,
    folder_id: str | None = None,
    unique: bool = True,
) -> dict:
    """Загружает файл в библиотеку и возвращает документ.

    По умолчанию содержимое помечается уникальным маркером: иначе дедуп по
    sha256 вернул бы документ другого теста.
    """
    payload = body + f"\n\nмаркер {uuid.uuid4().hex}".encode() if unique else body
    response = client.post(
        f"{PREFIX}/documents",
        files={"file": (name, io.BytesIO(payload), "text/plain")},
        data={"folder_id": folder_id} if folder_id else None,
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_folders_create_list_and_delete(client: TestClient) -> None:
    """Папки создаются, видны в списке с числом документов и удаляются."""
    root = client.post(f"{PREFIX}/folders", json={"name": "Нейрофизиология"})
    assert root.status_code == 201
    child = client.post(
        f"{PREFIX}/folders",
        json={"name": "Микросостояния", "parent_id": root.json()["id"]},
    )
    assert child.status_code == 201
    assert child.json()["parent_id"] == root.json()["id"]

    listed = client.get(f"{PREFIX}/folders").json()["items"]
    names = {item["name"] for item in listed}
    assert {"Нейрофизиология", "Микросостояния"} <= names

    assert client.delete(f"{PREFIX}/folders/{child.json()['id']}").status_code == 204
    remaining = {item["name"] for item in client.get(f"{PREFIX}/folders").json()["items"]}
    assert "Микросостояния" not in remaining


def test_upload_splits_sections_and_chunks(client: TestClient, folder: str) -> None:
    """Загрузка текста даёт фрагменты с заголовками разделов и статус ok."""
    document = _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)
    assert document["kind"] == "text"
    assert document["status"] == "ok"
    assert document["chunks"] >= 2
    assert document["text_chars"] > 0
    assert document["folder_id"] == folder

    detail = client.get(f"{PREFIX}/documents/{document['id']}").json()
    headings = {chunk["heading"] for chunk in detail["chunks"]}
    assert "Микросостояния ЭЭГ" in headings
    assert "Клиническое применение" in headings


def test_upload_dedupes_same_content(client: TestClient, folder: str) -> None:
    """Повторная загрузка того же файла возвращает существующий документ."""
    first = _upload(client, "a.txt", _TEXT.encode(), folder_id=folder, unique=False)
    second = _upload(client, "b.txt", _TEXT.encode(), folder_id=folder, unique=False)
    assert first["id"] == second["id"]
    page = client.get(f"{PREFIX}/documents", params={"folder_id": folder}).json()
    assert page["total"] == 1


def test_upload_rejects_oversized_file(client: TestClient) -> None:
    """Файл больше лимита — 413 с числом мегабайт, без записи на диск."""
    big = b"x" * (settings.knowledge_max_file_mb * 1024 * 1024 + 1)
    response = client.post(
        f"{PREFIX}/documents",
        files={"file": ("big.txt", io.BytesIO(big), "text/plain")},
    )
    assert response.status_code == 413
    assert "лимита" in response.json()["detail"]


def test_search_returns_tfidf_hits(client: TestClient, folder: str) -> None:
    """Поиск находит фрагмент по лексике и честно сообщает режим."""
    _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)
    response = client.get(f"{PREFIX}/search", params={"q": "депрессии класс C"})
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] == "tfidf"
    assert body["hits"]
    assert "депресс" in body["hits"][0]["text"].lower()
    assert body["hits"][0]["document_title"] == "microstates.txt"


def test_search_rejects_blank_query(client: TestClient) -> None:
    """Пустой запрос — 400, а не полная выдача."""
    assert client.get(f"{PREFIX}/search", params={"q": "   "}).status_code == 400


def test_annotations_and_tags(client: TestClient, folder: str) -> None:
    """Аннотация к фрагменту сохраняется, теги заменяются набором."""
    document = _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)
    detail = client.get(f"{PREFIX}/documents/{document['id']}").json()
    chunk_id = detail["chunks"][0]["id"]

    note = client.post(
        f"{PREFIX}/documents/{document['id']}/annotations",
        json={"note": "Сверить с обзором 2024", "chunk_id": chunk_id, "heading": "Введение"},
    )
    assert note.status_code == 201
    assert note.json()["chunk_id"] == chunk_id

    tags = client.put(
        f"{PREFIX}/documents/{document['id']}/tags",
        json={"tags": ["ЭЭГ", "микросостояния", "ЭЭГ"]},
    )
    assert tags.status_code == 200
    assert tags.json() == ["ЭЭГ", "микросостояния"]

    listed = client.get(f"{PREFIX}/tags").json()["items"]
    names = {tag["name"] for tag in listed}
    assert {"ЭЭГ", "микросостояния"} <= names

    refreshed = client.get(f"{PREFIX}/documents/{document['id']}").json()
    assert len(refreshed["annotations"]) == 1
    assert refreshed["document"]["tags"] == ["ЭЭГ", "микросостояния"]


def test_graph_keeps_only_confirmed_links(client: TestClient, folder: str) -> None:
    """В граф попадают подтверждённые рёбра; предложенное ИИ — нет."""
    document = _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)
    tag = client.post(f"{PREFIX}/tags", json={"name": f"ЭЭГ-{uuid.uuid4().hex[:6]}"}).json()

    confirmed = client.post(
        f"{PREFIX}/links",
        json={
            "from_kind": "document", "from_id": document["id"],
            "to_kind": "tag", "to_id": tag["id"], "relation": "mentions",
            "confirmed": True,
        },
    )
    assert confirmed.status_code == 201
    client.post(
        f"{PREFIX}/links",
        json={
            "from_kind": "document", "from_id": document["id"],
            "to_kind": "tag", "to_id": tag["id"], "relation": "related",
            "confirmed": False,
        },
    )

    graph = client.get(f"{PREFIX}/graph").json()
    edges = [edge for edge in graph["edges"] if edge["from_id"] == document["id"]]
    assert len(edges) == 1
    assert edges[0]["relation"] == "mentions"
    node_ids = {node["id"] for node in graph["nodes"]}
    assert document["id"] in node_ids and tag["id"] in node_ids


def test_delete_document_removes_files(client: TestClient, folder: str) -> None:
    """Удаление документа убирает и каталог файлов на диске."""
    document = _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)
    assert storage.document_dir(document["id"]).exists()
    assert client.delete(f"{PREFIX}/documents/{document['id']}").status_code == 204
    assert not storage.document_dir(document["id"]).exists()
    page = client.get(f"{PREFIX}/documents", params={"folder_id": folder}).json()
    assert page["total"] == 0


def test_attachments_attach_and_detach(client: TestClient, folder: str) -> None:
    """Вложение документа к нити чата добавляется, читается и снимается."""
    thread = client.post(
        "/api/v1/agent-chat/threads", json={"title": "Микросостояния"},
    ).json()
    document = _upload(client, "microstates.txt", _TEXT.encode(), folder_id=folder)

    created = client.post(
        f"{PREFIX}/threads/{thread['id']}/attachments",
        json={"kind": "document", "ref_id": document["id"], "label": "microstates.txt"},
    )
    assert created.status_code == 201
    again = client.post(
        f"{PREFIX}/threads/{thread['id']}/attachments",
        json={"kind": "document", "ref_id": document["id"], "label": "microstates.txt"},
    )
    assert again.json()["id"] == created.json()["id"]

    items = client.get(f"{PREFIX}/threads/{thread['id']}/attachments").json()["items"]
    assert len(items) == 1
    assert client.delete(f"{PREFIX}/attachments/{items[0]['id']}").status_code == 204
    assert client.get(f"{PREFIX}/threads/{thread['id']}/attachments").json()["items"] == []


def test_attachment_unknown_thread_is_404(client: TestClient) -> None:
    """Вложение к несуществующей нити — 404."""
    response = client.post(
        f"{PREFIX}/threads/missing/attachments",
        json={"kind": "web", "ref_id": "https://example.org", "label": "example"},
    )
    assert response.status_code == 404


def test_attachment_context_includes_report_and_analysis_heads(client: TestClient) -> None:
    """Отчёт и анализ без данных дают честный заголовок, а не выдуманный текст."""
    thread = client.post(
        "/api/v1/agent-chat/threads", json={"title": "Отчёты"},
    ).json()
    for payload in (
        {"kind": "report", "ref_id": "rec-missing", "label": "rec-missing"},
        {"kind": "analysis", "ref_id": "999", "label": "анализ 999"},
    ):
        created = client.post(
            f"{PREFIX}/threads/{thread['id']}/attachments", json=payload,
        )
        assert created.status_code == 201

    text = asyncio.run(knowledge_store.attachment_context(thread["id"]))
    assert "[Отчёт ЭЭГ «rec-missing»] id=rec-missing" in text
    assert "[Анализ ЭЭГ «анализ 999»] id=999" in text


def test_chunking_keeps_sections_and_overlap() -> None:
    """Нарезка не пересекает разделы и держит перекрытие внутри раздела."""
    sections = [
        extract.Section(heading="A", page=1, text="слово " * 400),
        extract.Section(heading="B", page=2, text="короткий текст"),
    ]
    chunks = chunking.chunk_sections(sections, size=500, overlap=100)
    assert chunks[0].heading == "A"
    assert chunks[-1].heading == "B"
    assert all(len(chunk.text) <= 500 for chunk in chunks)
    assert chunks[-1].text == "короткий текст"


def test_extract_pdf_without_text_layer_reports_empty(tmp_path) -> None:
    """PDF без текстового слоя даёт предупреждение, а не пустой документ."""
    from pypdf import PdfWriter

    path = tmp_path / "blank.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    with path.open("wb") as handle:
        writer.write(handle)

    result = extract.extract_pdf(path)
    assert result.sections == []
    assert any("Текстовый слой" in warning for warning in result.warnings)
