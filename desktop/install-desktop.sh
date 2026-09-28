#!/bin/bash
# Установка ярлыка DipLock в пользовательский профиль GNOME/Linux:
#   ./desktop/install-desktop.sh        # установка
#   ./desktop/install-desktop.sh remove # удаление ярлыка
# sudo не нужен — всё ставится в ~/.local/share.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS_DIR="$HOME/.local/share/applications"
ICONS_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
DESKTOP_SRC="$ROOT/desktop/DipLock.desktop"
ICON_SRC="$ROOT/desktop/diplock.svg"
LAUNCHER="$ROOT/start.sh"

if [[ "${1:-install}" == "remove" ]]; then
  rm -f "$APPS_DIR/DipLock.desktop" "$ICONS_DIR/diplock.svg"
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
  echo "Ярлык DipLock удалён."
  exit 0
fi

# Лаунчер обязан быть исполняемым — ярлык вызывает его напрямую.
chmod +x "$LAUNCHER"

mkdir -p "$APPS_DIR" "$ICONS_DIR"
# Exec прописываем абсолютным путём текущего клона (запись ровно один раз здесь).
sed "s|^Exec=.*|Exec=$LAUNCHER|" "$DESKTOP_SRC" >"$APPS_DIR/DipLock.desktop"
chmod +x "$APPS_DIR/DipLock.desktop"
cp "$ICON_SRC" "$ICONS_DIR/diplock.svg"

# Без index.theme в ~/.local/share/icons/hicolor GTK не индексирует пользовательскую
# тему, а gtk-update-icon-cache падает с «No theme index file» — берём системный.
if [[ ! -f "$HOME/.local/share/icons/hicolor/index.theme" ]]; then
  cp /usr/share/icons/hicolor/index.theme "$HOME/.local/share/icons/hicolor/index.theme" 2>/dev/null || true
fi

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$APPS_DIR/DipLock.desktop"
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS_DIR" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f "$HOME/.local/share/icons/hicolor" 2>/dev/null || true

echo "Ярлык DipLock установлен: $APPS_DIR/DipLock.desktop"
echo "Иконка: $ICONS_DIR/diplock.svg"
echo "Найдите «DipLock» в меню приложений; на рабочий стол — перетаскиванием."
