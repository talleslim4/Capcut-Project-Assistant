#!/bin/bash

set -e

APP_PATH="/Applications/CapCut Project Assistant.app"

echo "CapCut Project Assistant — primeira abertura"
echo

if [ ! -d "$APP_PATH" ]; then
  echo "O aplicativo não foi encontrado em Aplicativos."
  echo "Arraste CapCut Project Assistant para a pasta Aplicativos e execute este auxiliar novamente."
  echo
  read -r -p "Pressione Enter para fechar."
  exit 1
fi

echo "O macOS poderá solicitar sua senha para autorizar o aplicativo."
if ! /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH"; then
  sudo /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH"
fi
/usr/bin/open "$APP_PATH"

echo
echo "Autorização concluída."
read -r -p "Pressione Enter para fechar."
