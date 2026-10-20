# Instalação

## Requisitos

- Windows com **Microsoft Edge** (padrão) ou **Google Chrome** instalado (canal estável).
- **Node.js 24+** (usa `node:sqlite`, nativo). Testado com v24.19.0 em `C:\Program Files\nodejs\node.exe`.
- Dependências: `npm install` na pasta do projeto.

## Build

```powershell
git clone https://github.com/Antonio-byte10/mcp_linkedin_public.git "<PASTA>\mcp_linkedin_public"
cd "<PASTA>\mcp_linkedin_public"
npm install
npm run build        # compila src/ -> dist/
```

> Sempre que algo em `src/` mudar, rode `npm run build` de novo e reinicie o app que usa o MCP.

## Claude Desktop (uso principal)

Arquivo de configuração. Instalador padrão:

```
%APPDATA%\Claude\claude_desktop_config.json
```

Instalação via Microsoft Store/MSIX:

```
%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude_desktop_config.json
```

Exemplo de entrada:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<PASTA>\\mcp_linkedin_public\\dist\\server.js"]
    }
  }
}
```

Para usar o **Chrome** em vez do Edge, acrescente o bloco `env` à mesma entrada:

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["<PASTA>\\mcp_linkedin_public\\dist\\server.js"],
      "env": { "LINKEDIN_BROWSER": "chrome" }
    }
  }
}
```

- Faça um backup do arquivo antes de editar.
- Depois de editar: **feche o Claude Desktop pela bandeja (Sair)** e abra de novo.
- Logs do Desktop (`mcp-server-linkedin.log` e `mcp.log`): em `%APPDATA%\Claude\logs` no instalador padrão; em `%LOCALAPPDATA%\Claude\logs` na versão da Microsoft Store.

## Claude Code

```powershell
claude mcp add --scope user linkedin -- node "<PASTA>\mcp_linkedin_public\dist\server.js"
claude mcp get linkedin     # deve mostrar Status: Connected
claude mcp remove linkedin -s user   # para remover
```

Com o **Chrome** (o padrão é o Edge):

```powershell
claude mcp add --scope user linkedin -e LINKEDIN_BROWSER=chrome -- node "<PASTA>\mcp_linkedin_public\dist\server.js"
```

## Edge ou Chrome

O padrão é o **Microsoft Edge**. Para usar o **Google Chrome**, defina `LINKEDIN_BROWSER=chrome` no `env` do servidor (veja os exemplos acima). Depois de mudar o `env`, reinicie o app (Desktop) ou reconecte o servidor (Code: `/mcp` → linkedin → Reconnect).

- **Cada navegador tem o seu próprio perfil**: `<dados>/edge-profile/` para o Edge e `<dados>/chrome-profile/` para o Chrome. Eles nunca são compartilhados (um perfil gravado por um navegador pode ser recusado ou alterado pelo outro). Por isso você precisa **entrar no LinkedIn uma vez por navegador**; trocar de navegador sem logar antes dá `LOGGED_OUT`.
- O perfil é sempre dedicado ao MCP, nunca o seu navegador do dia a dia.
- Se o navegador escolhido não abrir, a resposta é `BROWSER_LAUNCH_FAILED`, com a dica de trocar de navegador.
- `BROWSER_EXECUTABLE_PATH` aponta para um executável específico em vez do navegador instalado (Edge/Chrome em local não padrão). Ele **não** troca o navegador: apontar para o Chrome sem `LINKEDIN_BROWSER=chrome` continua usando `<dados>/edge-profile/` e as mensagens dizem "Edge". Defina os dois juntos.
- Use o **mesmo** `LINKEDIN_BROWSER` no Claude Desktop e no Claude Code. Com navegadores diferentes seriam duas sessões simultâneas na mesma conta, e o ritmo/orçamento de leituras é contado por processo.
- **Primeiro uso do Chrome**: num perfil novo, a primeira abertura/fechamento pode levar cerca de 1 minuto (o Chrome termina a configuração em segundo plano ao fechar). Se o Claude Desktop estourar o tempo, chame `session_status` de novo.
- Se `LINKEDIN_BROWSER` tiver um valor inválido (ex.: `chrom`), o servidor avisa no log e usa o Edge.

## Pasta de dados

Tudo que é pessoal fica **fora da pasta do código**, em `%LOCALAPPDATA%\mcp-linkedin` (chamada de `<dados>` nesta documentação): o perfil logado do navegador (`edge-profile/`, `chrome-profile/`), o banco `linkedin.db`, o seu `answers.json`, as planilhas (`exports/`), os registros de candidatura (`applications/`) e os mapas (`form-maps/`, `page-maps/`). Assim nada pessoal vai junto quando o projeto é copiado ou publicado. No Windows essa pasta só é legível pelo seu usuário, pelo SYSTEM e por administradores.

- Outro lugar: defina `LINKEDIN_DATA_DIR` no `env` do servidor (o mesmo valor no Desktop e no Code).
- **Atualizou de uma versão anterior** (que guardava `data/`, `.edge-profile/` e `.chrome-profile/` dentro da pasta do código)? Feche o Claude Desktop e o Claude Code e rode, na pasta do código:

  ```powershell
  npm run migrate-data
  ```

  Ele move tudo para a pasta de dados (copia e confere entre discos diferentes), nunca sobrescreve o que já estiver lá e recusa mover o que estiver em uso. Enquanto isso não for feito, `session_status` mostra `data_warning`, e o MCP começa com login e cache vazios.

## Primeiro login

O MCP usa um **perfil próprio do navegador** (`<dados>/edge-profile/` para o Edge, `<dados>/chrome-profile/` para o Chrome, na pasta de dados), separado do seu navegador do dia a dia.

- Opção A: no Claude, peça *"abra o navegador do LinkedIn"* (ferramenta `browser_launch`; `edge_launch` continua funcionando como alias obsoleto) e faça login na janela que abrir.
- Opção B: `npm run browser` no terminal (usa o navegador escolhido em `LINKEDIN_BROWSER`; `npm run edge` é o mesmo comando), faça login, feche a janela.

O login fica salvo no perfil; não precisa repetir (só ao trocar de navegador, que tem outro perfil).

## Banco de respostas

Depois do login, monte o seu `<dados>/answers.json` (as respostas que as candidaturas usam): peça ao Claude *"monte meu banco de respostas do LinkedIn"* ou rode `npm run setup-answers` no terminal (um assistente que faz uma pergunta por vez, grava a cada resposta e retoma de onde parou). Nunca sobrescreve um arquivo que já exista. Veja [ANSWER_BANK.md](ANSWER_BANK.md).

## Usando nos dois apps

Claude Code e Claude Desktop rodam **cada um o seu servidor**, mas compartilham o mesmo perfil do navegador (desde que usem o mesmo `LINKEDIN_BROWSER`), que **só pode estar aberto em um processo por vez**:

- O navegador do MCP fecha sozinho após **3 minutos sem uso** (ou quando o app é fechado).
- Se um app chamar enquanto o outro está com o navegador aberto, a resposta é imediata: `PROFILE_BUSY`. Espere fechar ou feche a janela do navegador do MCP.
- O banco `<dados>/linkedin.db` é compartilhado (SQLite em modo WAL), então os dois veem o mesmo cache.

## Variáveis de ambiente (opcionais)

| Variável | Padrão | Efeito |
|---|---|---|
| `LINKEDIN_BROWSER` | `edge` | `edge` ou `chrome` (também aceita `msedge` e `google-chrome`); qualquer outro valor = Edge, com aviso no log |
| `LINKEDIN_AUTO_PURGE_DAYS` | desligado | Número inteiro de 1 a 3650: ao iniciar, apaga do cache as pessoas e empresas não vistas há esse número de dias, mais os lotes de `*_prepare` antigos (mesmas regras e proteções do `data_purge`: nunca toca no registro de ações, e mantém pessoas contatadas nos últimos 90 dias). Vazio, `0` ou valor inválido = desligado (o inválido é avisado no log). Cuidado com valores pequenos: `1` apaga todo o cache de pessoas e empresas a cada inicialização; recomendado 30 ou mais |
| `LINKEDIN_DATA_DIR` | `%LOCALAPPDATA%\mcp-linkedin` (fora do Windows: `~/.mcp-linkedin`) | Pasta de dados: perfis do navegador, banco, `answers.json`, planilhas, mapas |
| `BROWSER_PROFILE_DIR` | `<dados>/edge-profile` (Edge) ou `<dados>/chrome-profile` (Chrome) | Pasta do perfil do navegador escolhido |
| `LINKEDIN_DB` | `<dados>/linkedin.db` | Arquivo do banco (os testes usam um arquivo temporário) |
| `BROWSER_EXECUTABLE_PATH` | — (canal instalado) | Executável do navegador a abrir, em vez do instalado |
| `BROWSER_IDLE_CLOSE_MS` | `180000` (3 min) | Tempo ocioso até fechar o navegador |
| `EDGE_PROFILE_DIR` | — | Nome antigo de `BROWSER_PROFILE_DIR`, só vale para o Edge (continua funcionando) |
| `EDGE_IDLE_CLOSE_MS` | — | Nome antigo de `BROWSER_IDLE_CLOSE_MS` (continua funcionando) |
| `LINKEDIN_HEADLESS` | `1` | `0` mantém a janela sempre visível (por padrão ela só aparece para login/verificação) |
| `CALL_BUDGET_MS` | `30000` | Tempo máximo de trabalho por chamada (o Desktop corta em ~50 s) |
| `LIMIT_APPLY_DAILY` | `25` | Candidaturas por 24 h |
| `LIMIT_CONNECT_DAILY` / `LIMIT_CONNECT_WEEKLY` | `15` / `100` | Convites de conexão |
| `LIMIT_MESSAGE_DAILY` | `20` | Mensagens por 24 h |

Para usar no Desktop, adicione `"env": { "VAR": "valor" }` na entrada `linkedin`; no Claude Code, use `-e VAR=valor` no `claude mcp add`.

## Solução de problemas

| Mensagem | Causa | O que fazer |
|---|---|---|
| `PROFILE_BUSY` | O navegador do MCP está aberto em outro app/janela | Esperar 3 min, ou fechar aquela janela do navegador. Uma janela que o MCP abriu e que sobreviveu a um servidor encerrado à força (processo que a abriu já morto) é fechada sozinha na próxima chamada (Windows) |
| `LOGGED_OUT` | Sessão do LinkedIn expirou no perfil do MCP (ou você trocou de navegador e ainda não logou nele) | `browser_launch` e logar de novo |
| `CHECKPOINT` / `RATE_LIMITED` / `SUSPENDED` | LinkedIn pediu verificação ou limitou | Resolver na janela do navegador do MCP; depois pedir `session_resume` |
| `READ_BUDGET` | Limite diário de páginas daquele tipo atingido | Esperar a meia-noite (horário de São Paulo) |
| `BROWSER_LAUNCH_FAILED` | O navegador não abriu (antes `EDGE_LAUNCH_FAILED`) | Ver a mensagem; conferir se o Edge/Chrome está instalado/atualizado, ou trocar de navegador com `LINKEDIN_BROWSER` |
| Ferramentas não aparecem no Desktop | App não reiniciado ou erro no config | Sair pela bandeja e abrir; ver `mcp-server-linkedin.log` |
| Mudei o código e nada mudou | `dist/` desatualizado | `npm run build` e reiniciar o app |
