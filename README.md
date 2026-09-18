# CapCut Project Assistant

## Espelho do Google Drive

O espelho envia a pasta real do projeto ou da predefinição para uma pasta correspondente no Google Drive e atualiza somente arquivos novos ou alterados. Ele não cria ZIP/7z; esses formatos continuam disponíveis apenas na exportação manual. Fontes detectadas são copiadas para `__fonts__` dentro do espelho. Ao baixar a pasta pelo Drive, o ZIP gerado pode ser importado normalmente pelo aplicativo.

Ao atualizar uma versão antiga, desconecte e conecte novamente a conta do Google para renovar a permissão de acesso à pasta compartilhada.

Aplicativo desktop para localizar, importar e exportar projetos completos do CapCut no Windows e macOS.

Também inclui predefinições, fontes empacotadas, thumbnails, organização por clientes, árvore visual de pastas, seleção em massa, etiquetas, favoritos e análise de fontes ausentes.

O espelho do Google Drive é ativado individualmente em cada projeto ou predefinição. Ele mantém a pasta real no Drive, envia apenas arquivos novos ou alterados e remove do espelho os arquivos que deixaram de existir localmente. ZIP e 7z continuam disponíveis somente na exportação manual.

A organização continua usando clientes → pastas para projetos e pastas próprias para predefinições. Arquivos internos do CapCut são ocultados e thumbnails locais são exibidas quando o CapCut disponibiliza uma imagem de prévia. Na importação, o aplicativo reconhece fontes empacotadas e oferece instalá-las no perfil do usuário.

## Google Drive

O login acontece no navegador por OAuth. Tokens são armazenados somente no perfil local do aplicativo. A credencial desktop fica em `secrets/google-oauth-desktop.json`, caminho ignorado pelo Git, e é injetada nos instaladores pelo segredo `GOOGLE_OAUTH_DESKTOP_B64` do GitHub Actions. Para usar uma pasta compartilhada, o app solicita a permissão de escrita necessária no Drive; depois de atualizar uma versão antiga, desconecte e conecte novamente a conta para renovar o consentimento.

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
