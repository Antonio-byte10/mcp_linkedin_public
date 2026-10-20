# mcp_linkedin_public

MCP em TypeScript que opera a **sua própria conta do LinkedIn** num perfil dedicado do Microsoft Edge ou do Google Chrome (Playwright por pipe, sem porta de depuração). Busca e filtra vagas, gera planilhas com nível de match, sincroniza candidaturas, encontra recrutadores e decisores, prospecta empresas e, **só nos itens que você escolher**, envia candidaturas Easy Apply, convites de conexão e mensagens a contatos de 1º grau.

> Uso pessoal. Automatizar o LinkedIn pode violar os Termos de Uso da plataforma e causar restrição da conta. As travas de segurança (cotas, ritmo, lotes aprovados) reduzem o risco, mas não o eliminam. Você é responsável pelo que o MCP faz em seu nome.

Escopo: foco no Brasil (interface do LinkedIn em pt-BR, CPF/CLT, fuso America/Sao_Paulo).

**Documentação completa: [docs/README.md](docs/README.md)** · versão **0.9.0**

## Início rápido

```powershell
git clone https://github.com/Antonio-byte10/mcp_linkedin_public.git
cd mcp_linkedin_public
npm install
npm run build        # rode de novo sempre que mudar algo em src/
npm test             # 21 arquivos de teste (336 casos), sem navegador
```

- **Claude Desktop**: entrada `linkedin` em `claude_desktop_config.json` (veja [docs/INSTALL.md](docs/INSTALL.md)).
- **Claude Code**: `claude mcp add --scope user linkedin -- node "<PASTA>\mcp_linkedin_public\dist\server.js"`
- **Navegador**: Edge por padrão. Para usar o Chrome, defina `LINKEDIN_BROWSER=chrome` no `env` do servidor (Desktop: `"env": { "LINKEDIN_BROWSER": "chrome" }`; Code: acrescente `-e LINKEDIN_BROWSER=chrome` ao `claude mcp add`). Cada navegador tem o seu perfil (`<dados>/edge-profile/`, `<dados>/chrome-profile/`): faça login no LinkedIn uma vez por navegador. Detalhes em [docs/INSTALL.md](docs/INSTALL.md).
- **Primeiro uso**: peça "abra o navegador do LinkedIn" (`browser_launch`) e faça login na janela do MCP (ou `npm run browser`).
- **Depois de cada build, reconecte o servidor** no Claude Code (`/mcp` → linkedin → Reconnect). O servidor aberto continua com o código antigo até reconectar.
- **Pasta de dados** (`<dados>` nas docs): `%LOCALAPPDATA%\mcp-linkedin`, fora da pasta do código. Tudo que é pessoal fica lá: o perfil logado do navegador, o banco, as suas respostas e as planilhas. Outro lugar: `LINKEDIN_DATA_DIR`. Veio de uma versão anterior? Com o Claude fechado, rode `npm run migrate-data`.
- **Monte o seu banco de respostas** (as respostas que o `apply_execute` usa nos formulários): peça ao Claude *"monte meu banco de respostas do LinkedIn"* (ele usa `answers_check`, `answers_init` e `answers_set`, e só grava o que você disser) ou rode `npm run setup-answers` para um assistente no terminal, uma pergunta por vez. O arquivo `answers.json` fica na pasta de dados, **nunca no repositório**, e um banco que já existe nunca é substituído sem backup: o `answers_init` só recomeça com `overwrite: true`, guardando o arquivo antigo como backup ao lado. Detalhes em [docs/ANSWER_BANK.md](docs/ANSWER_BANK.md).

## Ferramentas (35)

| Grupo | Ferramentas |
|---|---|
| Sessão | `browser_launch` (`edge_launch` é alias obsoleto), `session_status`, `session_resume`, `quota_status` |
| Vagas (leitura) | `jobs_search`, `jobs_get`, `jobs_enrich`, `jobs_list_local`, `jobs_export_xlsx`, `tracker_sync` |
| Buscas salvas | `jobs_watch_save`, `jobs_watch_list`, `jobs_watch_delete`, `jobs_watch_run` (só vagas novas) |
| Dados locais | `pipeline_stats`, `data_purge` (LGPD) |
| Banco de respostas | `answers_check` (o que falta), `answers_init` (cria a partir do modelo), `answers_set` (grava o que você respondeu) |
| Candidatura (escrita) | `apply_prepare` (com prévia das respostas) → você escolhe → `apply_execute` |
| Pessoas (leitura) | `people_search`, `profile_get`, `people_export_xlsx`, `leads_find_decision_makers`, `leads_export_xlsx` |
| Conexões (escrita) | `connect_prepare` → você escolhe → `connect_execute` (nota opcional ou `note_template`) |
| Mensagens (escrita) | `message_prepare` → você escolhe → `message_execute` (`dry_run` por padrão) |
| Empresas (leitura) | `companies_search`, `companies_enrich` |
| Mapeamento (só leitura) | `map_easy_apply_form`, `map_page` |

Referência detalhada: [docs/TOOLS.md](docs/TOOLS.md). Exemplos de pedidos: [docs/WORKFLOWS.md](docs/WORKFLOWS.md).

## Como funciona a escrita

1. `*_prepare` mostra os candidatos e cria um lote de uso único (30 min).
2. Você escolhe os itens; o MCP **só** executa ids do lote, dentro das cotas (25 candidaturas/24 h, 15 convites/24 h, 100/7 dias, 20 mensagens/24 h).
3. Sucesso só é registrado **após confirmação do LinkedIn**; sem confirmação o item fica `unverified` (conta na cota e não repete).
4. `apply_execute` preenche as perguntas do formulário com o seu banco `<dados>/answers.json`. Para ver antes o que será respondido, mapeie o formulário (`map_easy_apply_form`, só leitura): o `apply_prepare` mostra em `answers_preview` cada resposta, o que falta e o que é sensível. Pergunta sem resposta no banco **não é inventada**: a candidatura é descartada e volta como `needs_answer` com a pergunta. Dados sensíveis (CPF, salário, diversidade) exigem `confirm_sensitive: true`.
5. Currículo é escolhido pelo idioma da vaga (`documents.resume_by_language`).
6. Notas de convite podem vir de modelos (`note_templates` em `<dados>/answers.json`): `connect_prepare` mostra a nota já renderizada de cada pessoa e `connect_execute` envia exatamente aquele texto.
7. `message_execute` começa em `dry_run` (abre a conversa, confere, fecha sem digitar). Só envia com `dry_run: false`, para contatos de 1º grau, sem InMail.

## Estado (validado ao vivo pelo autor, outubro/2026)

- Candidaturas Easy Apply, convites de conexão (com e sem nota) e mensagens a contatos de 1º grau foram enviados pelo MCP e conferidos no próprio LinkedIn (`tracker_sync`, lista de pendentes, conversa).
- Leitura (busca, detalhe, enriquecimento, pessoas, empresas, buscas salvas, decisores, mapeamento de formulários) funcionando.
- 21 arquivos de teste offline (336 casos; os que dependem das fixtures locais da sua pasta de dados viram `SKIP` sem elas) passando; `tsc` limpo em `src/` e `test/`.
- A prévia das respostas e a detecção de navegador órfão foram conferidas com formulários e processos reais. Os bugs achados nas rodadas ao vivo (leitor da conversa, modal de convite no DOM de 2026) foram corrigidos e revalidados; os testes de formulários rodam sobre os mapas da sua própria pasta de dados (`form-maps/`) e são pulados (`SKIP`) enquanto você não tiver mapas.
- **Não validado ao vivo**: o login no Chrome e o preenchimento real de typeahead/upload (veja as pendências).

## Pendências

Resumo (detalhes em [docs/TODO.md](docs/TODO.md)):

**Validar ao vivo**
- [ ] Chrome (`LINKEDIN_BROWSER=chrome`): login e uma sessão completa ao vivo.
- [ ] Candidatura: typeahead, dropdown customizado e upload de arquivo já são lidos pelo mapeador e pela prévia, mas ainda não foram preenchidos numa candidatura real. O upload só acontece com um caminho que você colocou à mão em `documents.resume_paths.<idioma>`; sem ele, o campo de arquivo obrigatório faz a vaga voltar em `needs_answer`, e o opcional fica em branco.
- [ ] Uma candidatura `unverified` confirmada pelo `tracker_sync` (só acontece quando o LinkedIn não confirma um envio).

**Seus dados**
- [ ] `free_text.pitch_short` / `why_company` vêm vazios no modelo: preencha o `<dados>/answers.json`, senão as perguntas abertas param a candidatura.

## Segurança e privacidade

- Navegador dedicado (`<dados>/edge-profile/` ou `<dados>/chrome-profile/`), nunca o seu Edge/Chrome normal. Nenhuma porta de depuração.
- Texto vindo do LinkedIn é tratado como dado não confiável (caracteres invisíveis removidos, envelope `untrusted_text`).
- Checkpoint, 429 ou limite semanal de convites travam a automação até `session_resume`.
- `data_purge` apaga do cache local pessoas/empresas (e, se pedido, vagas) não vistas há N dias; começa em `dry_run`.
- A pasta de dados (`%LOCALAPPDATA%\mcp-linkedin`: banco, respostas, planilhas, mapas de formulário e os perfis do navegador) fica só na sua máquina, fora da pasta do código; no Windows ela só é legível pelo seu usuário, pelo SYSTEM e por administradores.

Mais em [docs/SAFETY.md](docs/SAFETY.md).

## Documentos

[Instalação](docs/INSTALL.md) · [Fluxos](docs/WORKFLOWS.md) · [Ferramentas](docs/TOOLS.md) · [Planilha e match](docs/ANALYSIS.md) · [Banco de respostas](docs/ANSWER_BANK.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Segurança](docs/SAFETY.md) · [Mapa do DOM](docs/MAPPING.md) · [TODO](docs/TODO.md) · [Histórico](docs/CHANGELOG.md) · Licença: [MIT](LICENSE)
