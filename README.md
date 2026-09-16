# CapCut Project Assistant

Aplicativo desktop para localizar, importar e exportar projetos completos do CapCut no Windows e macOS.

Também inclui predefinições, fontes empacotadas, thumbnails, organização por clientes e pastas, ações em massa, etiquetas, favoritos e análise de fontes ausentes.

## Segurança da organização

Clientes, nomes personalizados, etiquetas, pastas virtuais e favoritos são armazenados nos dados do próprio aplicativo. Excluir essa organização não apaga projetos ou predefinições do CapCut. Somente a ação explícita de renomear um projeto altera o nome de sua pasta real.

## Desenvolvimento

```bash
npm install
npm start
```

## Gerar instaladores

- Windows: `npm run dist:win`
- macOS (execute em um Mac): `npm run dist:mac`

O pacote ZIP oferece compatibilidade ampla. O 7z usa compressão mais forte e é indicado para projetos grandes. O projeto importado recebe um novo nome automaticamente se já existir, evitando sobrescrita.

> Para mover um projeto entre computadores, os dois devem usar versões compatíveis do CapCut. Se o projeto referenciar mídias externas que não estejam dentro de sua pasta, o CapCut poderá pedir para religá-las no computador de destino.
