# Arquitetura

## Visão geral

```
Claude Desktop / Claude Code
        │  stdio (JSON-RPC MCP)
        ▼
 dist/server.js  ── registra 35 ferramentas (zod) ──┐
        │                                            │
        ├─ browserTool → withBrowser (fila única) ───┼─► Edge/Chrome (perfil <dados>/edge-profile ou chrome-profile, via pipe)
        │                    └─ nav(): ritmo, orçamento diário, trava, allowlist      │
        │                                                                             ▼
        │                                                                     www.linkedin.com
        └─ localTool  → SQLite <dados>/linkedin.db · <dados>/answers.json · <dados>/exports/*.xlsx
```

## Estrutura de pastas

| Caminho | Conteúdo |
|---|---|
| `src/server.ts` | Servidor MCP, schemas das ferramentas, instruções ao cliente, filtros `listLocal`, encerramento |
| `src/config.ts` | Raiz do projeto (a partir do próprio arquivo, nunca do cwd), pasta de dados (`resolveDataDir`: `LINKEDIN_DATA_DIR`, senão `%LOCALAPPDATA%\mcp-linkedin`) e aviso de dados antigos na pasta do código, escolha do navegador (`LINKEDIN_BROWSER`), perfil, cotas, orçamento por chamada |
| `src/browser/session.ts` | Abre o Edge ou o Chrome (`launchPersistentContext`, canal `msedge`/`chrome` ou `BROWSER_EXECUTABLE_PATH`), aba de trabalho, fila `withBrowser`, prazo por chamada (`deadline`/`hasTime`), fechamento por ociosidade, checagem de checkpoint/login |
| `src/browser/profileLock.ts` | Perfil ocupado (`lockfile` no Windows; `SingletonLock` com PID morto = órfão no Linux/macOS). Só arquivos: usado pelo servidor e pela migração |
| `src/browser/strayBrowser.ts` | Navegador órfão (Windows): processo principal aberto pelo Playwright (`--remote-debugging-pipe`) neste perfil (`--user-data-dir`) cujo processo-pai morreu. Só ele é encerrado; o seu Edge/Chrome, o do outro cliente e o de outras ferramentas nunca |
| `src/linkedin/applyPreview.ts` | `answers_preview` do `apply_prepare`: mapa salvo (`form-maps/<id>.json`) + banco → respostas que seriam enviadas, pelo mesmo planejador do preenchimento (`previewForm`). Sem navegador nem banco |
| `src/browser/nav.ts` | `nav()` único ponto de navegação: só `https://www.linkedin.com`, intervalo mínimo, orçamento diário por tipo, trava persistente (429/999/checkpoint); `afterAction()` |
| `src/browser/humanize.ts` | `sleep`, `jitter`, `pause` |
| `src/linkedin/jobs.ts` | Busca de vagas (lista Ember `li[data-occludable-job-id]`), detalhe da vaga (layout novo), link externo (`/safety/go?url=`) |
| `src/linkedin/tracker.ts` | Rastreador de candidaturas, paginação por clique, retomada, sincronização incremental |
| `src/linkedin/people.ts` | Busca de pessoas e perfil, envio de convites |
| `src/linkedin/dialog.ts` | Leitor único do diálogo Easy Apply, usado por `mapper.ts` e `formfill.ts` |
| `src/linkedin/noteTemplate.ts` | Modelos de nota de conexão (puro) |
| `src/linkedin/message.ts`, `messageRules.ts`, `messageDom.ts` | Mensagens a contatos de 1º grau: execução no navegador, regras puras testáveis e as funções que rodam na página (leem a bolha de 2026 dentro do shadow root `#interop-outlet`) |
| `src/linkedin/companies.ts` | Busca de empresas e página "Sobre" |
| `src/linkedin/dom.ts` | Funções que rodam dentro da página: `cardsByLink` (acha cards pelos links de entidade), `mainLines`, `pairs` |
| `src/linkedin/mapper.ts` | `map_easy_apply_form` e `map_page` (somente leitura) |
| `src/analysis/skills.ts` | Dicionário de skills e detecção em texto |
| `src/analysis/match.ts` | Senioridade, área, skills do usuário, nível de match |
| `src/answers/bank.ts` | Leitura de `target` do `answers.json`: área, empresas bloqueadas, modalidade, senioridade |
| `src/answers/setup.ts` | Montagem guiada do `answers.json`: catálogo de campos (`FIELDS`), verificação do que falta (`checkAnswers`, sem devolver valores), criação a partir do modelo (`initAnswers`, nunca sobrescreve sem backup), edição validada e tudo-ou-nada (`applyUpdates`) e gravação atômica (`saveAnswers`); base das ferramentas `answers_check` / `answers_init` / `answers_set` |
| `src/cli/setup-answers.ts` | `npm run setup-answers`: assistente no terminal (uma pergunta por vez, grava a cada resposta, retoma de onde parou) sobre o `src/answers/setup.ts` |
| `src/export/jobsReport.ts` | Planilha de análise (4 abas) |
| `src/export/xlsx.ts` | Planilha simples (pessoas, leads) |
| `src/guard/quota.ts` | Cotas de escrita com reserva atômica |
| `src/guard/ledger.ts` | Lotes por item (`claimItems`/`checkItems`), `runItems`, `withReservation`, `settleItems` |
| `src/store/watch.ts` | Buscas salvas (`jobs_watch_*`) |
| `src/store/purge.ts`, `src/store/stats.ts` | `data_purge` e `pipeline_stats` |
| `src/guard/untrusted.ts` | Corte e limpeza de texto de terceiros |
| `src/store/db.ts` | SQLite (`node:sqlite`), schema, migração de colunas, upserts |
| `src/store/migrateData.ts`, `src/cli/migrate-data.ts` | `npm run migrate-data`: move `data/`, `.edge-profile/`, `.chrome-profile/` da pasta do código para a pasta de dados (checkpoint do SQLite, cópia conferida, nunca sobrescreve) |
| `src/cli/launch-browser.ts` | `npm run browser` (ou `npm run edge`): abre o perfil do navegador escolhido para login manual |

## Ciclo de uma chamada de navegador

1. O cliente chama a ferramenta → `browserTool` → `withBrowser(fn)` entra na fila (uma chamada por vez, pois todas usam a mesma aba).
2. Ao começar, o prazo da chamada é fixado em *momento de entrada na fila + 30 s*; laços longos consultam `hasTime()` e devolvem resultado parcial antes do corte de ~50 s do Desktop.
3. `getPage()` abre o navegador se preciso. Antes, se o `lockfile` do perfil (ou o `SingletonLock`) estiver travado, encerra um navegador órfão do MCP (`strayBrowser.ts`) se houver; senão falha na hora com `PROFILE_BUSY` (sem abrir janela).
4. Cada carregamento passa por `nav()`: confere a trava, a allowlist e o orçamento diário, espera o intervalo mínimo, navega, trata 429/999 e roda `afterAction()` (checkpoint, saiu do LinkedIn, cookie `li_at`).
5. O extrator lê o DOM (por links de entidade + ordem das linhas; as classes CSS do LinkedIn são embaralhadas) e grava no SQLite.
6. Ao terminar, agenda o fechamento do navegador em 3 min (dentro da fila; não fecha se a aba estiver em login/verificação). Quando o host fecha o stdin, o navegador é fechado na hora.

## Banco SQLite (`<dados>/linkedin.db`, WAL, timeout 5 s)

| Tabela | Colunas principais |
|---|---|
| `jobs` | `id`, `title`, `company`, `location`, `url`, `easy_apply` (1/0/NULL), `posted`, `description`, `applied`, `closed`, `apply_url`, `tracker_seen`, `enriched_at`, `modality`, `employment_type`, `applicants`, `requirements` (JSON), `company_url`, `search_keywords`, `first_seen`, `last_seen` |
| `people` | `url`, `name`, `headline`, `company`, `role`, `location`, `degree`, `last_seen` |
| `companies` | `url`, `name`, `industry`, `size`, `website`, `location`, `last_seen` |
| `saved_searches` | buscas salvas (`jobs_watch_*`): nome, parâmetros, última execução |
| `actions` | registro de ações de escrita (`pending`/`done`/`failed`) usado pelas cotas |
| `batches` | lotes de aprovação (`id`, `kind`, `items`, `created_at`, `used`) — 30 min, uso único |
| `kv` | trava (`breaker`), orçamento diário de leituras (`reads:AAAA-MM-DD`), estado do rastreador (`tracker:<stage>:complete` / `resume_page`) |

Regras de gravação: string vazia nunca sobrescreve valor bom; `applied` e `closed` só vão de 0 para 1; `easy_apply` desconhecido (NULL) não apaga um valor conhecido. Colunas novas são adicionadas automaticamente em bancos antigos (`ensureColumns`).

## Arquivos de dados

| Caminho | O que é | Pode apagar? |
|---|---|---|
| `<dados>/edge-profile/` · `<dados>/chrome-profile/` | Perfil do Edge / do Chrome do MCP (login, cookies; um por navegador) | Só se quiser deslogar |
| `<dados>/linkedin.db*` | Cache de vagas/pessoas/empresas, cotas, trava | Sim (cache) |
| `<dados>/answers.json` | Seu banco de respostas | **Não** |
| `<dados>/exports/` | Planilhas geradas | Sim |
| `<dados>/form-maps/` | Mapas de formulários Easy Apply (JSON) | Sim, mas servem de teste para o `apply_execute` |
| `dist/` | Build | Sim (`npm run build` recria) |

## Decisões importantes

| Decisão | Por quê |
|---|---|
| Navegador por pipe (`launchPersistentContext`), não porta de depuração | Porta TCP sem autenticação permitiria a qualquer processo local assumir a sessão |
| Perfil dedicado, um por navegador | O navegador normal não pode ser automatizado; isola a sessão; Edge e Chrome nunca compartilham perfil (um pode recusar ou migrar o do outro) |
| Uma aba, fila única | Duas navegações simultâneas fariam um extrator ler a página do outro |
| Âncoras por link + linhas, não por classe CSS | O LinkedIn usa classes embaralhadas que mudam |
| Orçamento por chamada + retomada | Claude Desktop corta chamadas em ~50 s |
| `node:sqlite` | Sem compilação nativa no Windows |
