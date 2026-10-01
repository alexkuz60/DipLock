"""PHI-анонимизация заголовка EDF при загрузке (4.4, шаг ①; п.4.4 ``todo.md``).

Заголовок EDF фиксирован: байты ``8..88`` — «local patient identification»
(код, пол, дата рождения и **имя пациента**), ``88..168`` — «local recording
identification» (дата, административный идентификатор, оборудование и
**техник**). Имя пациента и техник — PHI: при регистрации записи оба поля
заменяются псевдонимом (поле B1 «человек (псевдоним)» в паспорте и в таблице
``recordings``). Исходные значения никуда не сохраняются — ни в сайдкар, ни в
БД, ни в ответ API.

Псевдоним детерминирован от sha256 **исходного** файла (``Patient-<6 hex>``):
повторная загрузка того же файла даёт тот же псевдоним; латиница обязательна —
EDF кодируется ISO 8859-1.

Анонимизируется **сохранённая копия** после подсчёта отпечатка: дедуп сравнивает
sha256 исходного содержимого, поэтому повтор той же загрузки снова опознаётся.
Сбой обезличивания — ошибка регистрации (fail closed): файл с PHI не остаётся
на диске (см. ``POST /recordings`` — при ``ValueError`` копия удаляется).
"""
import os
import re
import uuid

# Границы полей в байтах: версия(8) + patient(80) + recording(80) — дальше
# startdate/starttime, которые не содержат имен и остаются нетронутыми.
_PATIENT_FIELD = (8, 88)
_RECORDING_FIELD = (88, 168)

# Дата в поле записи (``02-MAR-24`` или ``02.03.24``): дублирует фиксированную
# startdate заголовка, поэтому её можно сохранить.
_DATE_RE = re.compile(r"^\d{2}([-.,])\d{2}\1\d{2}$")

_FIELD_WIDTH = 80


def patient_alias(digest: str | None) -> str:
    """Псевдоним «человек (псевдоним)» из отпечатка файла (B1).

    Без отпечатка (его считать не стали) — одноразовый токен: главное, чтобы
    это не было исходное имя.
    """
    token = (digest or uuid.uuid4().hex)[:6]
    return f"Patient-{token.lower()}"


def read_header_fields(path: str) -> tuple[str, str]:
    """Читает сырые поля ``(patient, recording)`` из заголовка EDF.

    Вызывается **до** обезличивания; короткий/битый файл — ``ValueError``.
    """
    size = os.path.getsize(path)
    if size < _RECORDING_FIELD[1]:
        raise ValueError(f"Файл меньше заголовка EDF ({size} байт)")
    with open(path, "rb") as fh:
        fh.seek(_PATIENT_FIELD[0])
        patient = fh.read(_PATIENT_FIELD[1] - _PATIENT_FIELD[0])
        recording = fh.read(_RECORDING_FIELD[1] - _RECORDING_FIELD[0])
    return patient.decode("latin-1"), recording.decode("latin-1")


def _pad(text: str) -> bytes:
    """Ровно 80 байт в ISO 8859-1 (небайтовые символы — заменой, не ошибкой)."""
    return text.encode("latin-1", "replace")[:_FIELD_WIDTH].ljust(_FIELD_WIDTH)


def _patient_field(alias: str) -> str:
    """Новое поле пациента: структура EDF (код/пол/дата/имя), имя = псевдоним.

    Прочие подполя исходника (код пациента, дата рождения) — тоже идентификаторы,
    поэтому заменяются целиком.
    """
    return f"{alias} O 01-JAN-1900 {alias}"


def _recording_field(original: str, alias: str) -> str:
    """Новое поле записи: только дата (не PHI) + псевдоним вместо остального.

    Порядок подполяй после даты (админ-id, оборудование, техник) стандарт не
    гарантирует, а техник — PHI: поэтому всё после даты заменяется целиком
    (оборудование и так дублируется в поле «transducer» каждого канала).
    """
    tokens = original.split()
    parts: list[str] = []
    if tokens and tokens[0].lower() == "startdate" and len(tokens) > 1:
        parts.extend(tokens[:2])  # «Startdate 02-MAR-24»
    elif tokens and _DATE_RE.match(tokens[0]):
        parts.append(tokens[0])
    parts.append(alias)
    return " ".join(parts)


def anonymize_edf_header(path: str, alias: str) -> None:
    """Заменяет PHI-подполя заголовка сохранённой копии на псевдоним (in place).

    Ошибки ввода-вывода поднимаются наружу: регистрация записи должна упасть,
    а не оставить на диске файл с именем пациента.
    """
    _original_patient, original_recording = read_header_fields(path)
    with open(path, "r+b") as fh:
        fh.seek(_PATIENT_FIELD[0])
        fh.write(_pad(_patient_field(alias)))
        fh.seek(_RECORDING_FIELD[0])
        fh.write(_pad(_recording_field(original_recording, alias)))
