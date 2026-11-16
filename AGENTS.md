# AGENTS.md — AI Account Switcher

Guia para agentes de IA (e pessoas) que trabalham neste repositório. **Mantenha este arquivo atualizado**: sempre que descobrir algo novo, mudar uma decisão ou corrigir um bug não óbvio, registre aqui no mesmo commit.

## O que é
App desktop (Electron, **Windows / macOS / Linux**) que:
- guarda várias contas do **Claude Code**, **Codex CLI** e **Cursor CLI** (`cursor-agent`) num cofre criptografado;
- troca com um clique a conta que cada CLI usa (botão no app ou menu da bandeja);
- mostra o consumo/limites de cada conta e os tokens por dia (logs locais);
- instala os CLIs pela interface;
- exporta/importa contas entre computadores (arquivo `.aias` protegido por senha);
- se atualiza sozinho pelo GitHub Releases.

**Público:** o dono (usuário brasileiro). Toda a interface, mensagens, commits e docs são em **português do Brasil**. O usuário quer **tudo pela interface gráfica, nada por terminal**.

- Repositório: https://github.com/M-tardelly/dashboard-ia-controller (público, branch `main`)
- Pasta local do dono: `C:\Users\mathe\Documents\IA\projeto-dashboard`

## Como o dono quer que o agente trabalhe
- Faça você mesmo o **commit, o push e o lançamento** das versões. Não deixe passos manuais para ele.
- Antes de fazer o commit: rode `node tests/switch-test.js` e atualize este AGENTS.md (e o README, se mudar algo visível para o usuário).
- Mensagens de commit em português. Termine com o trailer `Co-Authored-By` indicado pelo ambiente.
- Nunca faça commit de dados de conta, tokens, e-mails pessoais ou de `dist/`/`node_modules/`.

## Estrutura
```
src/main.js              processo principal: janela, bandeja, IPC, diálogos, notificações, modo de captura de tela
src/preload.js           ponte segura (contextIsolation); lista branca de canais IPC
src/updater.js           atualização via GitHub Releases (electron-updater + modo "avisar")
src/core/manager.js      núcleo: cofre, sincronização com o login ativo, troca, login isolado, consumo, export/import
src/core/transfer.js     cifra do arquivo .aias (scrypt + AES-256-GCM)
src/core/util.js         utilitários multiplataforma: PATH, processos, terminal de login, Keychain (macOS), fetch
src/core/providers/      um módulo por CLI: claude.js, codex.js, cursor.js (mesma interface)
src/renderer/            interface (HTML/CSS/JS puro, sem framework e sem build): index.html, styles.css, app.js
tests/switch-test.js     teste de troca A→B→A→B com contas fictícias numa HOME falsa (Windows/Linux)
build/make-icon.js       gera build/icon.png (1024px) sem dependências
.github/workflows/release.yml   workflow "Lançar versão"
```

## Interface de um provedor (`src/core/providers/*.js`)
`id, name, cliName, color, installHint`, `findCli()`, `installCommand()`, `readLive()` (async), `writeLive(snap)` (async), `identity(snap) → {key,email,name,plan,org}`, `loginSpec() → {dir,args,env,collect,before?,after?}`, `refreshIfNeeded(snap)`, `fetchUsage(snap) → {windows:[{label,percent,resetsAt}],notes,plan,error?}`, `scanLocalUsage(sinceMs)`.
O "snapshot" (`snap`) é o conteúdo bruto dos arquivos de login do CLI, que fica guardado e cifrado no cofre.

## Onde cada CLI guarda o login (descoberto lendo os próprios binários)
| CLI | Windows | macOS | Linux |
|---|---|---|---|
| Claude Code | `~/.claude/.credentials.json` | Keychain: serviço `Claude Code-credentials`, conta `claude-code-user` | `~/.claude/.credentials.json` |
| Codex | `~/.codex/auth.json` (ou `$CODEX_HOME`) | idem | idem |
| Cursor CLI | `%APPDATA%\Cursor\auth.json` | Keychain: `cursor-access-token` / `cursor-refresh-token`, conta `cursor-user` | `$XDG_CONFIG_HOME/cursor/auth.json` |

- Claude: a exibição da conta vem de `oauthAccount` em `~/.claude.json` (e em `$CLAUDE_CONFIG_DIR/.claude.json`). O app troca **só** essa chave e preserva o resto do arquivo.
- Claude no macOS com `CLAUDE_CONFIG_DIR` definido: o serviço do Keychain ganha o sufixo `-` + os 8 primeiros caracteres do `sha256(configDir NFC)`. É assim que o login isolado é recolhido no Mac.
- Cursor: a exibição vem de `authInfo` em `~/.cursor/cli-config.json` (ou `$CURSOR_CONFIG_DIR`). Na troca, o app também remove os caches ligados à conta anterior (`privacyCache`, `serverConfigCache`, `autoReviewAvailabilityCache`).
- O app troca só o login do **Cursor CLI**. O login do **editor** Cursor fica em `state.vscdb`, e o app não mexe nele.

## Login isolado (adicionar conta sem desconectar a atual)
- Claude: `claude auth login` com `CLAUDE_CONFIG_DIR=<pasta temporária>`.
- Codex: `codex login` com `CODEX_HOME=<pasta temporária>` e `config.toml` contendo `cli_auth_credentials_store = "file"`.
- Cursor: `cursor-agent login` com `APPDATA` (Windows) ou `XDG_CONFIG_HOME` (Linux) apontando para a pasta temporária, mais `CURSOR_CONFIG_DIR`. **No macOS não dá para isolar** (o Keychain é um só): o `before()` guarda o login atual e limpa o Keychain, e o `after()` devolve o login anterior.
- A janela de login é aberta assim:
  - Windows: `cmd /c start "título" /wait cmd /c "<exe> <args>"`. Usar `stdio: ignore` com `detached` deixaria o CLI sem console.
  - macOS: script `.command` aberto com `open -a Terminal`.
  - Linux: o primeiro emulador de terminal encontrado. Sem nenhum, roda em segundo plano e abre o link `https://` que o CLI imprimir.
  - No macOS/Linux, o fim do login é detectado por arquivos de controle (`pid`/`done`).
- O manager verifica a coleta a cada 2,5 s. Chamadas simultâneas compartilham a mesma promessa (`login.collecting`).
- Durante um login, `syncLive` daquela ferramenta é suspenso e `activate` é bloqueado.

## Troca de conta (`manager.activate`)
1. `syncLive(tool)`: lê o login ativo. Se ele pertence a uma conta salva, guarda os tokens mais recentes (os CLIs renovam e rotacionam tokens sozinhos). Se é uma conta desconhecida, importa como nova.
2. `writeLive(snap)` da conta escolhida, com escrita atômica (arquivo temporário + rename, permissão 600).
3. Registra em `history` (usado para atribuir os tokens dos logs locais à conta ativa em cada horário).

A identidade de cada conta (`key`):
- Claude: `accountUuid` ou e-mail. Sem identidade, assume a conta ativa. **Nunca use o refresh token como chave**: ele muda a cada renovação.
- Codex: `email:account_id`.
- Cursor: `sub` do JWT.

## Consumo (endpoints NÃO oficiais — podem mudar)
- **Claude**: `GET https://api.anthropic.com/api/oauth/usage` com `Authorization: Bearer`, `anthropic-beta: oauth-2025-04-20` **e `User-Agent: claude-code/<versão>`**. Sem esse User-Agent a resposta é sempre 429. Retorna `five_hour`, `seven_day`, `seven_day_opus`… com `utilization` e `resets_at`. Renovação do token: `POST https://console.anthropic.com/v1/oauth/token` (com `platform.claude.com` como alternativa), client_id `9d1c250a-e61b-44d9-88ed-5944d1962f5e`. Perfil da conta: `/api/oauth/profile`.
- **Codex**: `GET https://chatgpt.com/backend-api/wham/usage` com Bearer e `ChatGPT-Account-Id`. Retorna `rate_limit.primary_window` e `secondary_window` (`used_percent`, `reset_at`). Renovação: `POST https://auth.openai.com/oauth/token`, client_id `app_EMoamEEZ73f0CkXaXp7hrann`.
- **Cursor**: `GET https://cursor.com/api/usage-summary` com o cookie `WorkosCursorSessionToken=<userId>%3A%3A<accessToken>` (o `userId` é a parte do `sub` depois do `|`). Os valores vêm em centavos. O plano vem de `membershipType`.
- Contas **inativas** têm o token renovado pelo próprio app quando expiram. A conta **ativa** nunca é renovada pelo app, para não brigar com o CLI pela rotação do refresh token.
- Intervalo mínimo entre consultas: Claude 3 min, demais 1 min. Se a consulta falhar, o app mostra o último valor conhecido marcado como "stale".
- Tokens locais: os logs do Claude ficam em `~/.claude/projects/**/*.jsonl` (`message.usage`, sem repetir o mesmo `message.id`+`requestId`). Os do Codex em `~/.codex/sessions/**/*.jsonl` (eventos `token_count`, campo `last_token_usage`). O Cursor não grava logs de tokens.

## Segurança
- Cofre: `<userData>/vault.json`, cifrado com `safeStorage`: DPAPI (Windows), Keychain (macOS), libsecret/KWallet (Linux). No Linux com o backend `basic_text`, o app marca `secure=false` e mostra um aviso.
- Exportação `.aias`: chave derivada com scrypt (N=2^16, r=8, p=1) e cifra AES-256-GCM. O cabeçalho entra como AAD. Senha mínima de 8 caracteres. O arquivo só mostra em texto os rótulos das contas, nunca os tokens.
- Mesma conta em dois computadores: quando o serviço renova o token num deles, o outro pode precisar de "Entrar novamente".
- Renderer com `contextIsolation`, `sandbox` e CSP `default-src 'self'`. Use `esc()` em todo HTML que receba dados.

## Atualizações e lançamento
- `package.json → build.publish`: GitHub `M-tardelly/dashboard-ia-controller`, `releaseType: draft`. O `updater.js` lê a mesma configuração.
- Windows e Linux AppImage: o `electron-updater` baixa em segundo plano e instala ao reiniciar ou ao sair do app.
- macOS e `.deb`: modo "avisar". O app consulta `api.github.com/.../releases/latest` e abre o `.dmg` ou `.deb` certo. Atualização silenciosa no Mac exige assinatura Apple, que não temos.
- **Lançar versão**: workflow `Lançar versão` (workflow_dispatch, entrada `versao` maior que a do package.json). Etapas:
  1. Testes (Ubuntu e Windows).
  2. `npm version`, commit "Versão X", tag `vX` e release em rascunho.
  3. `electron-builder --win/--mac/--linux --publish always`.
  4. `gh release edit --draft=false --latest`.

  Os apps só enxergam a versão depois do passo 4.
- Disparar o workflow pela API: `POST /repos/M-tardelly/dashboard-ia-controller/actions/workflows/release.yml/dispatches` com `{"ref":"main","inputs":{"versao":"X.Y.Z"}}`. O `gh` não está logado na máquina do dono. O token do Git Credential Manager (`git credential fill`) serve para isso.
- Depois que o workflow roda, `main` recebe o commit "Versão X". Faça `git pull` antes do próximo commit.
- Instaladores sem assinatura: o Windows SmartScreen pede "Executar assim mesmo"; no macOS, botão direito → Abrir.

## Comandos
```
npm install
npm start                       # roda em modo dev (o atualizador fica desligado)
node tests/switch-test.js       # teste de troca (Windows/Linux; no macOS é pulado)
npm run dist:win | dist:mac | dist:linux
npm run icon
```
Ganchos de teste por variável de ambiente (só para depuração):
- `AIAS_SCREENSHOT=arquivo.png`: captura a tela e fecha o app. Usa uma pasta userData separada, então não conflita com uma instância aberta.
- `AIAS_VIEW=overview|claude|codex|cursor|install|transfer|updates`: página que abre na captura.
- `AIAS_SHOT_DELAY=ms`: espera antes da captura.
- `AIAS_UPDATE_FEED=http://127.0.0.1:porta/`: troca o GitHub por um feed `generic` local. Exige `resources/app-update.yml` no app; o build `--dir` não gera esse arquivo.

## Armadilhas já encontradas
- Desde o Node 20, `spawn` de `.cmd`/`.bat` sem `shell: true` lança EINVAL. O `util.run` monta a linha de comando com `shell` só nesses casos.
- O app fecha para a bandeja: antes de `quitAndInstall` é preciso marcar `quitting = true` (o `Updater` recebe `beforeQuit`).
- `requestSingleInstanceLock`: com outra instância aberta, um segundo `electron .` sai em silêncio.
- Builds: o `.dmg` só pode ser gerado no macOS. O AppImage pode ser gerado no WSL Ubuntu, com Node portátil em `/tmp`.
- O WSL tem Ubuntu sem Node instalado: para rodar os testes de Linux, baixe o Node portátil em `/tmp`.
- `safeStorage.*String` sincronos geram aviso de "deprecated" no Electron 45, mas funcionam. Migrar para as versões async é uma melhoria futura.

## Testado / não testado
- Testado:
  - Windows: leitura e troca reais (gravação idêntica dos arquivos de login), consumo real do Claude, Codex e Cursor, login isolado, janela de login.
  - Windows e Linux: teste de troca A→B→A→B.
  - Exportação e importação, inclusive senha errada e arquivo adulterado.
  - Ciclo de atualização (verificar → baixar → validar sha512), com um feed local.
- **Não testado**:
  - macOS inteiro (Keychain e modo "avisar").
  - Login completo no navegador para adicionar uma segunda conta real.
  - A primeira execução do workflow de release.
