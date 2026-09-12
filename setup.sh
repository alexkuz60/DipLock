#!/bin/bash
# Сохраните как setup.sh и выполните: bash setup.sh
# Или выполните по шагам в терминале VS Code

mkdir -p backend/app/{core,api,services,models,utils}
mkdir -p backend/app/core
mkdir -p backend/app/api
mkdir -p backend/app/services
mkdir -p backend/app/models
mkdir -p backend/app/utils

# Создаём __init__.py
touch backend/app/__init__.py
touch backend/app/core/__init__.py
touch backend/app/api/__init__.py
touch backend/app/services/__init__.py
touch backend/app/models/__init__.py
touch backend/app/utils/__init__.py
