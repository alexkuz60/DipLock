import { Panel } from '@/shared/ui/Panel'

export function NeuromusicPanel() {
  return (
    <Panel
      title="Партитура"
      hint="Как устроен рендер (эксперимент, docs/rules/neuromusic.md)"
    >
      <ul className="space-y-2 text-sm text-fg-2">
        <li className="ui-list-row py-1">
          7 полос мозговых волн = 7 инструментов: каждая полоса поднимается на 7 октав (×128) и
          звучит отдельным треком.
        </li>
        <li className="ui-list-row py-1">
          Сцена L/C/R по карте монтажа: левые и правые электроды — по краям стерео, срединные
          (Fz/Cz/Pz/Oz) — по центру в оба канала.
        </li>
        <li className="ui-list-row py-1">
          Вход: дефолтная очистка (гармоники notch, интерполяция мёртвых, ICA) и авто-notch 50 Гц —
          против свиста 6.4 кГц в партитуре.
        </li>
        <li className="ui-list-row py-1">
          Треки нормированы к −18 dBFS (все инструменты слышны), мастер — сумма с контролем пика
          −1 dBFS.
        </li>
        <li className="ui-list-row py-1">
          Партитура (.json) фиксирует веса, гейны и отпечаток входа — задел под будущие
          3D-панорамирование, реверберацию и дипольные траектории.
        </li>
      </ul>
    </Panel>
  )
}
