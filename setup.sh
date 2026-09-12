#!/bin/bash
# Сохраните как setup.sh и выполните: bash setup.sh
# Или выполните по шагам в терминале VS Code

mkdir -p dip-lock/backend/app/{core,api,services,models,utils}
mkdir -p dip-lock/backend/app/core
mkdir -p dip-lock/backend/app/api
mkdir -p dip-lock/backend/app/services
mkdir -p dip-lock/backend/app/models
mkdir -p dip-lock/backend/app/utils

# Создаём __init__.py
touch dip-lock/backend/app/__init__.py
touch dip-lock/backend/app/core/__init__.py
touch dip-lock/backend/app/api/__init__.py
touch dip-lock/backend/app/services/__init__.py
touch dip-lock/backend/app/models/__init__.py
touch dip-lock/backend/app/utils/__init__.py
