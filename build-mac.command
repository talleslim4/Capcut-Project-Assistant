#!/bin/bash
set -e
cd "$(dirname "$0")"

export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "Instalando dependencias..."
npm install

echo "Gerando aplicativos para Intel e Apple Silicon..."
npx electron-builder --mac dmg zip --x64 --arm64

echo
echo "Concluido. Os arquivos estao em outputs/dist."
echo "Pressione Enter para fechar."
read
