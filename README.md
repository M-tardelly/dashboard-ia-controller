# AI Account Switcher

Aplicativo para **Windows, macOS e Linux** que guarda várias contas do **Claude Code**, **Codex CLI** e **Cursor CLI**, troca a conta usada por cada CLI com um clique e mostra o consumo de cada conta.

## Instalar
| Sistema | Arquivo | Observação |
|---|---|---|
| Windows | `AI Account Switcher-<versão>-win-x64.exe` | O instalador não é assinado. Se aparecer "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**. |
| macOS | `AI Account Switcher-<versão>-mac-<arm64/x64>.dmg` | O app não é assinado. Na primeira vez, clique com o botão direito no app → **Abrir**. Se o macOS disser que o app "está danificado", vá em Ajustes do Sistema → Privacidade e Segurança → **Abrir Mesmo Assim**. |
| Linux | `AI Account Switcher-<versão>-linux-x86_64.AppImage` (ou `.deb`) | Torne o AppImage executável (Propriedades → Permitir executar) e abra. |

O instalador de **Windows** e o **AppImage de Linux** estão em `dist/`. O `.dmg` do Mac só pode ser gerado num Mac. Você tem duas opções: rodar `npm run dist:mac` num Mac, ou subir o projeto para o GitHub e usar o workflow **Actions → Build instaladores → Run workflow**, que gera os três instaladores.

## Usar
- **Visão geral**: a conta em uso em cada ferramenta, os limites (sessão de 5h, semanal, mensal) e os tokens gastos por dia.
- **Página de cada ferramenta**: cartões das contas. **Usar esta conta** troca a conta do CLI. No menu `⋯` você pode atualizar o consumo, renomear, entrar novamente ou remover a conta.
- **Adicionar conta**: abre uma janela de login e você entra no navegador. O login acontece numa pasta separada, então a conta atual não é desconectada.
- **Instalação dos CLIs**: instala ou atualiza cada CLI. Se o Node.js não estiver instalado, ele é instalado antes do Codex (no Windows via winget, no Mac via Homebrew).
- **Importar / exportar**: gera um arquivo `.aias` protegido por senha com as contas escolhidas. Para levar as contas a outro computador (de qualquer sistema), importe esse arquivo lá.
- **Ícone na bandeja ou barra de menus**: troca a conta sem abrir a janela.

Depois de trocar de conta, feche e reabra as sessões do CLI que estiverem abertas.

## Onde cada CLI guarda o login
| CLI | Windows | macOS | Linux |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json` | Keychain (`Claude Code-credentials`) | `~/.claude/.credentials.json` |
| Codex | `~/.codex/auth.json` | `~/.codex/auth.json` | `~/.codex/auth.json` |
| Cursor CLI | `%APPDATA%\Cursor\auth.json` | Keychain (`cursor-access-token` / `cursor-refresh-token`) | `~/.config/cursor/auth.json` |

O app também atualiza os dados de exibição da conta (`oauthAccount` em `~/.claude.json` e `authInfo` em `~/.cursor/cli-config.json`).

No Mac, o Cursor guarda o login num Keychain único, então o login isolado funciona de outro jeito: durante o login de uma conta nova, o app guarda o login atual e o devolve no final.

## Segurança
- **Cofre local**: criptografado pelo sistema (DPAPI no Windows, Keychain no macOS, libsecret/KWallet no Linux). No Linux sem chaveiro ativo, o app avisa que a proteção é fraca.
- **Arquivo exportado**: AES-256-GCM, com a chave derivada da sua senha via scrypt. A senha precisa ter no mínimo 8 caracteres. Senha errada ou arquivo alterado são detectados. O arquivo dá acesso às contas, então apague-o depois de importar.
- **Mesma conta em dois computadores**: quando um deles renova o token, o outro pode precisar de **⋯ → Entrar novamente**.
- **Endpoints de consumo**: não são APIs públicas oficiais e podem mudar.

## Atualizações (via GitHub)
Instale uma vez a partir da página **Releases** do repositório. Depois disso:
- **Windows e Linux (AppImage)**: o app verifica o GitHub ao abrir e a cada 4 horas e baixa a versão nova em segundo plano. Para instalar, clique em **Reiniciar e atualizar**, ou feche o app pelo menu da bandeja.
- **macOS e Linux (.deb)**: o app avisa que há versão nova e baixa o instalador com um clique. A atualização silenciosa no Mac exige um certificado pago da Apple.

As contas salvas são mantidas entre versões.

### Como lançar uma versão nova (só pelo site do GitHub)
1. Envie as mudanças de código para o repositório.
2. No GitHub, abra **Actions → Lançar versão → Run workflow**.
3. Digite o número da versão, maior que a atual (ex.: `1.2.0`), e se quiser escreva as novidades.
4. Clique em **Run workflow**. Em cerca de 15 minutos o release é publicado com os instaladores de Windows, macOS e Linux, e os apps instalados recebem a atualização.

O workflow roda os testes antes. Se algo falhar, nada é publicado.

## Desenvolvimento
```
npm install
npm start                 # roda o app
node tests/switch-test.js # teste de troca com contas fictícias (Windows/Linux)
npm run dist:win          # instalador Windows
npm run dist:mac          # .dmg (precisa de um Mac)
npm run dist:linux        # AppImage + .deb (precisa de Linux, ou WSL)
```
