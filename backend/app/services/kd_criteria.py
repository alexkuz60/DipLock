"""КД — критерий годности диполя (С0): вердикт и базис нормировки (concept.md §3).

Один владелец правила «момент ≥ X % максимума **своего поддиапазона** И
GOF ≥ порога»: раньше оно жило только в ``results_store._persist_report``,
а пакетный прогон (С1, ``dipole_batch``) считает те же вердикты для кластеров
и сопоставления полос — вторая копия формулы разъехалась бы молча.

Правила (``docs/rules/results-db.md`` §8.4 п.5, ``docs/data-blocks.md`` §2.2):

* без порогов методики (``kd_moment_share``/``kd_gof_min``) вердикт —
  честный ``None`` («не оценено»), а не ``False``;
* базис (``kd_basis``) несёт оба базиса нормировки — иначе числа разных
  поддиапазонов молча встанут в один ряд;
* максимум момента — **внутри своей полосы** (``moment_max_nam``).
"""
from typing import Any

from app.core.config import KD_GOF_BASIS, KD_MOMENT_BASIS, Settings

# Имя внутреннего ключа точек пакета/отчёта, где лежат точки одной полосы
# (плоские словари ``DipoleScanPointOut``: ``amplitude_nam``, ``gof``).


def kd_basis_for(
    points: list[dict[str, Any]], cfg: Settings,
) -> tuple[dict[str, Any], list[int | None], int | None]:
    """Считает базис КД и вердикты точек одной полосы.

    Возвращает ``(kd_basis, verdicts, n_kd_passed)``:

    * ``kd_basis`` — ``{moment_share_x, gof_min, moment_max_nam, moment_basis,
      gof_basis}`` (``KdBasisOut``);
    * ``verdicts`` — по одному на точку: ``1`` — прошёл, ``0`` — нет,
      ``None`` — «не оценено» (пороги методики не заданы);
    * ``n_kd_passed`` — число прошедших; ``None`` — вердикт не считался.
    """
    amplitudes = [
        float(p["amplitude_nam"]) for p in points if p.get("amplitude_nam") is not None
    ]
    moment_max = max(amplitudes) if amplitudes else None
    share = cfg.kd_moment_share
    gof_min = cfg.kd_gof_min
    evaluated = share is not None and gof_min is not None and moment_max is not None
    kd_basis: dict[str, Any] = {
        "moment_share_x": share,
        "gof_min": gof_min,
        "moment_max_nam": moment_max,
        # Базисы нормировки (concept.md §3): обязательная часть описания порога
        "moment_basis": KD_MOMENT_BASIS,
        "gof_basis": KD_GOF_BASIS,
    }

    verdicts: list[int | None] = []
    for point in points:
        amplitude = point.get("amplitude_nam")
        gof = point.get("gof")
        verdict: int | None = None
        if (
            share is not None and gof_min is not None and moment_max is not None
            and amplitude is not None and gof is not None
        ):
            verdict = int(
                float(amplitude) >= share * moment_max
                and float(gof) >= gof_min
            )
        verdicts.append(verdict)
    n_kd_passed = sum(v for v in verdicts if v) if evaluated else None
    return kd_basis, verdicts, n_kd_passed
