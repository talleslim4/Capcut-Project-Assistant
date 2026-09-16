# CapCut Project Assistant

Aplicativo desktop para localizar, importar e exportar projetos completos do CapCut no Windows e macOS.

Também inclui predefinições, fontes empacotadas, thumbnails, organização por clientes, árvore visual de pastas, seleção em massa, etiquetas, favoritos e análise de fontes ausentes.

A versão 1.7.1 oculta arquivos internos do CapCut, permite criar pastas diretamente nos clientes, criar clientes pelo modal de edição e exportar em ZIP as fontes detectadas que estejam instaladas. Projetos usam a estrutura clientes → pastas; predefinições possuem pastas próprias e thumbnails locais quando o CapCut disponibiliza uma imagem de prévia. A exportação de fontes inclui um manifesto e exige que o usuário respeite a licença de redistribuição de cada arquivo.

Na organização em massa, **Selecionar visíveis** respeita o cliente, a pasta e o texto pesquisado. Ao selecionar somente um projeto, a ação **Renomear/editar projeto** pode alterar o nome de sua pasta real no CapCut.

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

### Primeira abertura no macOS

Os pacotes públicos gratuitos não são notarizados pela Apple. Depois de arrastar o aplicativo para **Aplicativos**, tente primeiro clicar com o botão direito nele e escolher **Abrir**. Se o macOS informar que o aplicativo está danificado, baixe `Abrir-no-macOS.command` no mesmo Release, clique nele com o botão direito, escolha **Abrir** e siga as instruções. O auxiliar atua somente sobre `/Applications/CapCut Project Assistant.app`.

O pacote ZIP oferece compatibilidade ampla. O 7z usa compressão mais forte e é indicado para projetos grandes. O projeto importado recebe um novo nome automaticamente se já existir, evitando sobrescrita.

> Para mover um projeto entre computadores, os dois devem usar versões compatíveis do CapCut. Se o projeto referenciar mídias externas que não estejam dentro de sua pasta, o CapCut poderá pedir para religá-las no computador de destino.
