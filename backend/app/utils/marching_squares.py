"""Изолинии бинарной маски (марширующие квадраты) без внешних зависимостей.

Зачем свой код
--------------
Контуры анатомических структур и полей Бродмана нужны серверу как **вектор**
(точки в мм MNI), а не как картинка: UI рисует их SVG-путями и по ним же считает
попадание клика (`frontend/src/shared/lib/atlasContours.ts`). matplotlib дал бы
изолинии «из коробки», но в рантайм бэкенда он не тянется осознанно (так же
сделаны топокарты — готовые PNG, `services/spectral.py`), а ``skimage``/``shapely``
в проекте нет вовсе.

Как считается
-------------
Маска — сетка сэмплов; контур идёт по серединам рёбер между соседними сэмплами,
то есть всегда лежит **между** узлами (на полшага от них) и всегда замкнут.
Маска дополняется нулевой рамкой: структура, касающаяся края среза, всё равно
даёт замкнутый контур, а не обрыв.

Дырки (желудочек внутри структуры) возвращаются **отдельными полигонами**:
на клиенте заливка идёт по правилу even-odd, поэтому «кольцо» закрашивается
правильно — без анализа вложенности на сервере.

Точки — в тех же единицах, что переданы осям (мм MNI): модуль не знает ни про
плоскости, ни про раскладку UI, ни про перевороты осей. Знаки — дело вызывающего.
"""
from collections.abc import Sequence

import numpy as np

# Рёбра клетки (в «удвоенных» индексах — целые числа, поэтому склейка петель
# идёт по словарю кортежей int, без сравнения float):
#   A(i, j) — B(i+1, j) — C(i+1, j+1) — D(i, j+1)
#   AB = (2i+1, 2j), BC = (2i+2, 2j+1), CD = (2i+1, 2j+2), DA = (2i, 2j+1)
_AB, _BC, _CD, _DA = 0, 1, 2, 3

# Код клетки = биты A|B<<1|C<<2|D<<3; значение — рёбра, которые пересекает контур.
# Седла (5 и 10) разрешаются фиксированно: выбор одной из двух схем на клетку
# в 1 мм — это сдвиг контура на полпикселя, а не «дырка» в геометрии.
_CASE_EDGES: dict[int, tuple[tuple[int, int], ...]] = {
    1: ((_AB, _DA),),
    2: ((_AB, _BC),),
    3: ((_DA, _BC),),
    4: ((_BC, _CD),),
    5: ((_AB, _BC), (_CD, _DA)),
    6: ((_AB, _CD),),
    7: ((_CD, _DA),),
    8: ((_CD, _DA),),
    9: ((_AB, _CD),),
    10: ((_AB, _DA), (_BC, _CD)),
    11: ((_BC, _CD),),
    12: ((_DA, _BC),),
    13: ((_AB, _BC),),
    14: ((_AB, _DA),),
}


def polygon_area_mm2(points: Sequence[tuple[float, float]]) -> float:
    """Площадь замкнутого полигона по формуле шнуровки (мм², по модулю)."""
    if len(points) < 3:
        return 0.0
    xs = np.asarray([point[0] for point in points], dtype=np.float64)
    ys = np.asarray([point[1] for point in points], dtype=np.float64)
    return float(abs(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))) / 2.0)


def simplify_polyline(
    points: Sequence[tuple[float, float]], tolerance_mm: float
) -> list[tuple[float, float]]:
    """Упрощение ломаной алгоритмом Дугласа—Пекера (толеранс в мм).

    Сетка 1 мм даёт по точке на пиксель контура: у крупной структуры это сотни
    точек, а для отрисовки и хит-теста достаточно десятых долей точности.
    Отклонение упрощённого контура от исходного не больше толеранса.
    """
    pts = [(float(x), float(y)) for x, y in points]
    if len(pts) < 3 or tolerance_mm <= 0:
        return pts

    def rdp(chunk: list[tuple[float, float]]) -> list[tuple[float, float]]:
        if len(chunk) < 3:
            return chunk
        start = np.asarray(chunk[0], dtype=np.float64)
        end = np.asarray(chunk[-1], dtype=np.float64)
        segment = end - start
        length = float(np.hypot(segment[0], segment[1]))
        body = np.asarray(chunk[1:-1], dtype=np.float64)
        if length < 1e-9:
            distances = np.hypot(body[:, 0] - start[0], body[:, 1] - start[1])
        else:
            cross = np.abs(
                segment[0] * (start[1] - body[:, 1]) - (start[0] - body[:, 0]) * segment[1]
            )
            distances = cross / length
        farthest = int(np.argmax(distances))
        if float(distances[farthest]) <= tolerance_mm:
            return [chunk[0], chunk[-1]]
        left = rdp(chunk[: farthest + 2])
        right = rdp(chunk[farthest + 1:])
        return left[:-1] + right

    return rdp(pts)


def _edge_points(index: np.ndarray, edge: int) -> tuple[np.ndarray, np.ndarray]:
    """Координаты середин рёбер клеток (в удвоенных индексах) для одного ребра."""
    i, j = index[:, 0], index[:, 1]
    if edge == _AB:
        return 2 * i + 1, 2 * j
    if edge == _BC:
        return 2 * i + 2, 2 * j + 1
    if edge == _CD:
        return 2 * i + 1, 2 * j + 2
    return 2 * i, 2 * j + 1


def _trace_loops(
    adjacency: dict[tuple[int, int], list[tuple[int, int]]]
) -> list[list[tuple[int, int]]]:
    """Склеивает сегменты контура в замкнутые петли (координаты — удвоенные индексы)."""
    used: set = set()
    loops: list[list[tuple[int, int]]] = []
    for start, neighbours in adjacency.items():
        for neighbour in neighbours:
            key = frozenset((start, neighbour))
            if key in used:
                continue
            used.add(key)
            loop = [start]
            previous, current = start, neighbour
            while current != start:
                loop.append(current)
                forward = None
                for candidate in adjacency[current]:
                    if candidate == previous:
                        continue
                    candidate_key = frozenset((current, candidate))
                    if candidate_key in used:
                        continue
                    forward = candidate
                    used.add(candidate_key)
                    break
                if forward is None:
                    break
                previous, current = current, forward
            # Петля из трёх сегментов и больше — это контур; две точки дают вырождение
            if len(loop) >= 4:
                loops.append(loop)
    return loops


def trace_mask_contours(
    mask: np.ndarray,
    x_mm: np.ndarray | Sequence[float],
    y_mm: np.ndarray | Sequence[float],
    *,
    simplify_mm: float = 0.6,
) -> list[list[tuple[float, float]]]:
    """Контуры бинарной маски как список замкнутых полигонов в мм.

    ``mask[a, b]`` — сэмплы по осям ``x_mm`` и ``y_mm`` (равномерная сетка).
    Дырки возвращаются отдельными полигонами: на клиенте они заливаются по
    правилу even-odd, поэтому «кольцо» не закрашивается.
    """
    values = np.asarray(mask, dtype=bool)
    if values.ndim != 2:
        raise ValueError("Маска должна быть двумерной")
    x_values = np.asarray(x_mm, dtype=np.float64)
    y_values = np.asarray(y_mm, dtype=np.float64)
    if values.shape != (x_values.size, y_values.size):
        raise ValueError("Форма маски не совпадает с длиной осей")

    padded = np.zeros((values.shape[0] + 2, values.shape[1] + 2), dtype=np.uint8)
    padded[1:-1, 1:-1] = values
    cells = (
        padded[:-1, :-1]
        | (padded[1:, :-1] << 1)
        | (padded[1:, 1:] << 2)
        | (padded[:-1, 1:] << 3)
    )
    index = np.argwhere((cells != 0) & (cells != 15))
    if index.size == 0:
        return []
    codes = cells[index[:, 0], index[:, 1]]

    adjacency: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for code in np.unique(codes):
        subset = index[codes == code]
        for first, second in _CASE_EDGES[int(code)]:
            ax, ay = _edge_points(subset, first)
            bx, by = _edge_points(subset, second)
            # Длины массивов заданы ``_edge_points`` (по одному на сэмпл клетки),
            # ``strict=False`` сохраняет прежнюю семантику склейки петель.
            for px, py, qx, qy in zip(ax, ay, bx, by, strict=False):
                a = (int(px), int(py))
                b = (int(qx), int(qy))
                adjacency.setdefault(a, []).append(b)
                adjacency.setdefault(b, []).append(a)

    step_x = float(x_values[1] - x_values[0]) if x_values.size > 1 else 0.0
    step_y = float(y_values[1] - y_values[0]) if y_values.size > 1 else 0.0
    origin_x, origin_y = float(x_values[0]), float(y_values[0])
    # Рамка сдвигает индексы на 1: удвоенный индекс `p` соответствует исходному
    # сэмплу `(p - 2) / 2`, откуда и берётся координата в мм (контур лежит на
    # полшага от узла, поэтому координаты дробные — это нормально).
    low_x, high_x = float(x_values.min()), float(x_values.max())
    low_y, high_y = float(y_values.min()), float(y_values.max())

    contours: list[list[tuple[float, float]]] = []
    for loop in _trace_loops(adjacency):
        points: list[tuple[float, float]] = []
        for px, py in loop:
            x = origin_x + ((px - 2) / 2.0) * step_x
            y = origin_y + ((py - 2) / 2.0) * step_y
            points.append(
                (
                    min(high_x, max(low_x, round(x, 3))),
                    min(high_y, max(low_y, round(y, 3))),
                )
            )
        simplified = simplify_polyline(points, simplify_mm)
        if len(simplified) >= 3:
            contours.append(simplified)
    return contours
