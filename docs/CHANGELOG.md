# Histórico

## 0.9.0 — cópia pública e banco de respostas guiado

Em 20/10/2026:
- **Cópia pública** (`mcp_linkedin_public`): os dados do autor foram removidos do código, dos testes e da documentação (o banco de respostas real, os mapas de formulário e nomes pessoais). O teste de cobertura dos mapas de formulário (`form-maps/`) ficou genérico: em vez de uma resposta esperada por pergunta do autor, exige que cada campo dos mapas de qualquer usuário tenha uma origem no banco ou um motivo declarado. Nada pessoal vai no repositório; tudo fica na pasta de dados.
- **Banco de respostas guiado**, para quem começa do zero:
  - 3 ferramentas novas (35 no total): `answers_check` (o que falta, sem mostrar valores, com as próximas perguntas), `answers_init` (cria o `answers.json` a partir do modelo; nunca sobrescreve, e `overwrite: true` guarda um backup datado) e `answers_set` (grava o que o usuário respondeu, validado e tudo-ou-nada; skills com anos).
  - `npm run setup-answers`: assistente no terminal com as mesmas perguntas, grava a cada resposta e retoma de onde parou.
  - Código em `src/answers/setup.ts` (catálogo de campos, verificação, criação, edição e gravação atômica) e `src/cli/setup-answers.ts`; o `server.ts` ganhou uma frase nas instruções para quem ainda não tem `answers.json`.
  - A gravação atômica descarta o cache de leitura do `answers.json` (`forgetAnswers` em `bank.ts`), então a próxima chamada já vê a mudança, mesmo com o mesmo tamanho de arquivo.
- O modelo público `answers.template.json` não traz mais cargos, senioridade, modalidades nem skills de ninguém (listas vazias; dois modelos de nota neutros, `geral` e `recrutador`), então o assistente pergunta tudo e `ready_to_apply` exige ao menos uma skill com `knows: true`. Endurecimento: valores numéricos com teto por campo, `learned` só com as chaves documentadas e tamanhos limitados, e uma gravação que falha remove o arquivo temporário.
- Revisão final antes de publicar: `answers_set` e o assistente recusam os caminhos de arquivo que são enviados (`documents.resume_paths.*`, `documents.cover_letter.file`; só à mão no `answers.json`); números negativos recusados em qualquer campo e `profile.years_in_data` entrou no assistente; chaves reservadas (`__proto__`, `constructor`, `prototype`) recusadas em `note_templates`; o erro de JSON inválido do `answers.json` traz só a posição, nunca um trecho do arquivo; um `answers_init` com `overwrite` que falha ao gravar restaura o arquivo antigo e informa onde está o backup; o arquivo temporário da gravação leva o PID do processo; Ctrl+C no assistente sai com código 0 dizendo que o progresso foi salvo. `.gitignore` cobre os arquivos de dados caso `LINKEDIN_DATA_DIR` aponte para dentro do repositório. Documentação: caminhos do Claude Desktop (instalador padrão e Microsoft Store) e JSON de exemplo válido no INSTALL.
- 21 arquivos de teste, 336 casos (o `ℹ tests` do Node mostra 143).

## 0.8.1 — CI, limpeza LGPD automática opt-in

Em 20/10/2026, sem mudança de comportamento para quem não ativa nada:
- **CI no GitHub Actions** (`.github/workflows/ci.yml`): `npm ci`, typecheck, testes e build a cada push na `main` e a cada pull request.
- **`LINKEDIN_AUTO_PURGE_DAYS`** (opcional, 1 a 3650): ao iniciar, o servidor apaga do cache as pessoas, empresas e lotes de `*_prepare` mais antigos que N dias, com as mesmas regras do `data_purge` (vagas e registro de ações nunca são tocados; pessoas contatadas nos últimos 90 dias são mantidas). Vem desligada; uma falha vai para o log sem impedir o servidor de iniciar. Veja [SAFETY.md](SAFETY.md).
- Versão 0.8.1 no `package.json`, no `package-lock.json` e no nome do servidor MCP.
- 20 arquivos de teste, 280 casos (o `ℹ tests` do Node mostra 87).

## 0.8.0 — escritas validadas ao vivo, formulários novos

Validado ao vivo:
- **Candidatura real** (`apply_execute`): `done` confirmado pelo LinkedIn.
- **Convite com nota** (`connect_execute` + `note_template`): o primeiro tentou e falhou **sem enviar nada** (timeout no clique). Causa: o modal de convite de 2026 vive num shadow root, e a página guarda diálogos ocultos de menus de anúncio; o código usava o último diálogo do documento, que era um oculto sem o botão "Adicionar nota". Agora vale só o diálogo **visível** que tem o texto do convite. O reenvio saiu `done` (Pendente conferido). Um clique que falha antes do envio diz em qual passo parou (`more_menu`, `connect_control`, `add_note`, `note_box`) e traz os controles vistos.
- **Mensagem real** (`message_execute`, `dry_run: false`): a primeira foi entregue mas voltou `unverified`. No DOM de 2026, cada mensagem traz uma lista interna de reações rápidas (emoji `<ul><li>`), e o leitor da conversa descartava todo `<li>` com outro `<li>` dentro, ou seja, todas as mensagens. Um diagnóstico local confirmou o envio (corpo de 201 caracteres igual ao texto, indicador "sent"); o registro foi marcado `done`. Com o leitor corrigido, a mensagem seguinte saiu `done` pelo próprio MCP. Mensagens deixam de ser "experimentais" (`dry_run` continua o padrão).
- **Regras novas no resolver**, a partir de formulários novos mapeados:
  - nível de idioma na escala do LinkedIn **em português** (Nenhuma / Conversação / Proficiente / Nativo ou bilíngue);
  - listas com "ou" ("Tableau or Looker or Qlik", "one of the following: SQL, Python, or R", "Power BI ou Looker Studio"): nenhuma ferramenta no banco = 0 / Não; qualquer uma conhecida = Sim. "e"/"and" nunca divide (pode ser parte do nome). Anos com uma conhecida e outra não continuam sem resposta;
  - "Quantos anos de experiência com X **você tem**?": o "você tem" não entra no nome da skill;
  - "Qual seu **último ou atual** salário?" (sensível), "Você **trabalharia** presencialmente?" (o banco vence o "Sim" que o LinkedIn preenche), "trabalhar híbrido no escritório" é híbrido, e pergunta que também afirma onde você mora ("Reside em Exemplópolis e tem disponibilidade…") para em `residence_in_question`;
  - "personal relationship with a current … employee", "presently employed by", país onde você mora (pela sua cidade no banco), "Associate's Degree" (tecnólogo);
  - resposta que caiu na parte cortada de uma lista longa no mapa salvo: motivo `option_not_in_truncated_map` em vez de "sem opção".
- `map_easy_apply_form`: sem botão Easy Apply, lê o topo da vaga e grava encerrada / já candidatada no cache (vagas encerradas continuavam sendo oferecidas pelo `apply_prepare`).
- Dica de campo do formulário: o contador e o texto para leitor de tela vinham colados ("0/200 de 20 caracteres"); agora "0/20 0 de 20 caracteres".
- Cache de pessoas: migração única junta as grafias da mesma URL (`/in/x`, `/in/x/`, `/in/x/pt`) e limpa o "X e mais 23 conexões em comum" gravado como nome por versões antigas.
- `answers.template.json`: 3 modelos de nota de convite (`note_templates`).
- A versão informada pelo servidor MCP agora tem teste contra o `package.json` (estava fixa em 0.7.3).
- 20 arquivos de teste, 274 casos.

## 0.7.3

- Validado ao vivo: o passo de revisão do `map_easy_apply_form` sai mascarado (`N*** S***`, `***1234`); `jobs_watch_run` voltou a trazer datas de publicação.
- Data de publicação só com a primeira linha do `<time>` (vinha "Há 16 horas" + "Nas últimas 24 horas" numa linha só); linhas já gravadas assim foram aparadas.

## 0.7.2 — privacidade dos mapas

- **Vazamento corrigido**: o `map_easy_apply_form` mascarava nome e telefone só nos campos preenchidos; o texto livre do passo de revisão (`dialog_text`) repetia o **nome completo e o telefone** da conta sem máscara, no arquivo de `form-maps/` e na resposta ao Claude. Agora nome e telefone (em qualquer formato: `11 9…`, `(11) 9…-…`, `+55 …`) são mascarados em todo o texto, com os valores do próprio formulário e do `answers.json` (`profile.first_name`, `last_name`, `phone.national`). O `map_page` (JSON e resposta) passa pelo mesmo mascaramento (o menu do LinkedIn mostra o seu nome). Os mapas já salvos que continham esses dados foram remascarados; os registros de candidatura já estavam limpos. Os HTML do `save_html` continuam com tudo (opcional e documentado).
- `jobs_search` / `jobs_watch_run`: data de publicação também pela linha "há 2 dias" do card quando ele não tem `<time>` (os cards sem `<time>` ficavam sem data).
- 20 arquivos de teste, 267 casos.

## 0.7.1 — testes ao vivo da 0.7.0

Rodada ao vivo (só leitura: `quota_status`, `pipeline_stats`, `apply_prepare`, `map_easy_apply_form`, `jobs_enrich`, `tracker_sync`; nada enviado):
- **Resposta errada corrigida**: "Tem disponibilidade para atuar presencialmente 3x por semana…?" era respondida **Não** por `mobility.accepts_onsite`; presencial só alguns dias por semana agora é híbrido (`accepts_hybrid`), com Sim só dentro de `target.hybrid_area` (lugar da pergunta ou da vaga), senão `needs_answer` (`hybrid_outside_hybrid_area`). Entradas de modelo como `"<cidade>"` não contam como área.
- **`learned[]` utilizável**: cada pergunta sem resposta na prévia traz `label_norm` (a chave exata), `kind` e as opções, para você aprovar uma resposta própria em `answers.json` (documentado em ANSWER_BANK). Pergunta de salário/benefícios/diversidade/CPF respondida por `learned` continua sensível (`confirm_sensitive`, mascarada).
- Prévia sem a linha duplicada do currículo (o campo de upload ao lado da lista de currículos salvos).
- **`tracker_sync`**: um card sem empresa ("Brasil • (Remoto)") gravava a localização como empresa; separador "•" reconhecido e card só com lugar vira localização. A linha afetada no cache foi corrigida.
- 20 arquivos de teste, 266 casos (o `ℹ tests` do Node mostra 78).

## 0.7.0 — prévia das respostas e travas finais

- **`apply_prepare` mostra o que será enviado** (`answers_preview`, `preview: false` desliga): idioma da vaga (escolhe o currículo) e, para vagas com formulário mapeado (`map_easy_apply_form`), cada pergunta com a resposta e a origem no banco (`source`; pessoais e sensíveis como `***`), as sem resposta (`unanswered`: a vaga pararia em `needs_answer`) e as que exigem `confirm_sensitive`. `ready` = mapa até o envio e nada faltando; `complete` = o mapa chegou ao envio. Usa o mesmo planejador do preenchimento real (`previewForm`), sem navegador. O mapa salvo mascara o e-mail/telefone/nome da conta; a prévia os confere contra o banco (senão um select de e-mail aparecia como sem resposta).
- **Navegador órfão** (`src/browser/strayBrowser.ts`, Windows): quando o perfil está travado, um navegador aberto pelo Playwright neste perfil cujo processo-pai morreu (servidor encerrado à força) é encerrado e a chamada segue, em vez de `PROFILE_BUSY` até alguém fechar a janela à mão. O seu Edge/Chrome, o navegador do outro cliente (pai vivo) e o de outras ferramentas (outro perfil) nunca são tocados (conferido nos processos reais). Ao vivo, matar o servidor fez o navegador sair sozinho em 0,5–1,5 s, então o encerramento em si não pôde ser exercitado; o caso coberto é o da 0.5.0 (Chrome lento para fechar no primeiro uso).
- **`message_execute`**: `done` também exige a caixa de texto vazia depois do Enviar; texto ainda na caixa = `unverified`. Fecha o risco residual de uma mensagem antiga idêntica fazer um envio que falhou parecer `done`.
- **`connect_execute`**: se o LinkedIn enviar o convite no primeiro clique (sem modal), um convite pedido com nota volta com `note_sent: false` e `warning` em vez de um `done` silencioso.
- Documentação: `tracker_sync` já confirmava candidaturas `unverified` e o `apply_execute` já reconferia modalidade/localização no cartão da vaga (ambos estavam listados como pendentes); WORKFLOWS não diz mais que o envio da candidatura "não está implementado"; tabela de estado do `docs/README.md` atualizada.
- Dependências: playwright-core 1.64.1, zod 4.6.7 (patch).
- 20 arquivos de teste, 262 casos (o `ℹ tests` do Node mostra 78).

## 0.6.0 — dados fora da pasta do código

- **Pasta de dados**: o perfil logado do navegador, o banco, o `answers.json`, as planilhas, os registros de candidatura e os mapas saem da pasta do código e vão para `%LOCALAPPDATA%\mcp-linkedin` (fora do Windows, `~/.mcp-linkedin`). Nada pessoal vai junto ao copiar ou publicar o projeto; no Windows a pasta só é legível pelo seu usuário, SYSTEM e administradores. `LINKEDIN_DATA_DIR` muda o lugar; `BROWSER_PROFILE_DIR`, `EDGE_PROFILE_DIR` e `LINKEDIN_DB` continuam valendo. Os perfis passam a se chamar `edge-profile/` e `chrome-profile/`.
- **Atualização**: `npm run migrate-data` (com o Claude fechado) move `data/`, `.edge-profile/` e `.chrome-profile/` para a pasta de dados: copia e confere entre discos, faz checkpoint do SQLite e move o banco com o `-wal`/`-shm` como uma unidade, nunca sobrescreve e recusa o que estiver em uso. Enquanto houver dados antigos na pasta do código, o servidor avisa no log e o `session_status` mostra `data_warning` e `data_dir`.
- A detecção de lock do perfil virou um módulo só de arquivos (`src/browser/profileLock.ts`), usado pelo servidor e pela migração.
- Testes de fixtures locais (`page-maps`, `form-maps`, `answers.json` real) leem da pasta de dados; nenhum teste cria a pasta de dados real.
- Migração robusta: cópia entre discos vai para `*.mcp-partial` e só ganha o nome final depois de conferida (uma execução interrompida não deixa cópia pela metade); o que a configuração atual usa (`LINKEDIN_DATA_DIR`, `BROWSER_PROFILE_DIR`, `LINKEDIN_DB` apontando para a pasta do código) fica no lugar e não gera aviso.
- **`message_execute` no DOM de 2026** (`dry_run_ok` pelo próprio MCP depois da migração, login preservado; nada digitado, cota intacta): o clique no link de mensagem antes de o app de mensagens montar no `#interop-outlet` (~2–4 s após carregar) era engolido e nenhuma bolha abria; agora espera o app (`messagingOverlayState`) e, se ele não montar, falha com `messaging_overlay_not_ready` sem clicar. Chip de destinatário aninhado contava como dois destinatários (`multiple_recipients`); "Fechar rascunho da conversa" reconhecido como fechar. Funções de página em `messageDom.ts`.
- 18 arquivos de teste, 253 casos com as fixtures locais (o `ℹ tests` do Node mostra 69).

## 0.5.0 — navegador portátil, mensagens, buscas salvas e LGPD (só testes offline)

Validação ao vivo pendente para `message_execute` (repetir o `dry_run`), convites com `note_template` e login no Chrome (ver [TODO.md](TODO.md)). 32 ferramentas; 17 arquivos de teste, 245 casos (o `ℹ tests` do Node mostra só 61 porque 10 arquivos usam um harness próprio que conta como um teste por arquivo).

**Navegador**
- Edge continua o padrão; **Chrome** via `LINKEDIN_BROWSER=chrome` (no `env` do Desktop ou `claude mcp add -e LINKEDIN_BROWSER=chrome`). Perfis separados: `.edge-profile/` e `.chrome-profile/`; é preciso logar uma vez por navegador.
- Novas variáveis `BROWSER_PROFILE_DIR`, `BROWSER_EXECUTABLE_PATH`, `BROWSER_IDLE_CLOSE_MS`; `EDGE_PROFILE_DIR` e `EDGE_IDLE_CLOSE_MS` continuam valendo.
- `browser_launch` (nova); `edge_launch` virou alias **obsoleto**. Erro `BROWSER_LAUNCH_FAILED` (antes `EDGE_LAUNCH_FAILED`) com dica de trocar de navegador. `session_status` devolve `browser` e `browser_open` (`edge_open` mantido). `npm run browser` (`npm run edge` é o mesmo comando).

**Novas ferramentas**
- `message_prepare` / `message_execute` (**experimental**): mensagem a contatos de 1º grau, lote aprovado, `dry_run` por padrão, InMail/Premium recusado, texto com SHA-256, sem repetição em 7 dias, cota `LIMIT_MESSAGE_DAILY`. Ver [SAFETY.md](SAFETY.md).
- `jobs_watch_save` / `jobs_watch_list` / `jobs_watch_delete` / `jobs_watch_run`: buscas salvas (máx. 20); a rodada devolve só vagas novas, com orçamento de tempo e `left`.
- `data_purge` (LGPD, `dry_run` por padrão, protege vagas aplicadas, lotes abertos e pessoas contatadas nos últimos 90 dias) e `pipeline_stats` (funil local). Coluna `last_seen` em pessoas, empresas e vagas.

**Convites e planilha**
- Modelos de nota: `note_templates` em `data/answers.json`; `note_template` em `connect_prepare` (mostra `note_preview`) e `connect_execute`. Marcadores `{first_name}`, `{company}`, `{role}`, trechos `[opcionais]`, máximo de 300 caracteres. Ver [ANSWER_BANK.md](ANSWER_BANK.md).
- Colunas **Anos de experiência exigidos** e **Faixa salarial** na aba "Vagas"; dicionário de skills ampliado.

**Correções e refatorações**
- `people_search`: o nome não é mais trocado pelo texto "conexões em comum"; fixtures de convite sensíveis ao estado do perfil.
- Leitor único do diálogo Easy Apply (`src/linkedin/dialog.ts`) para o mapeador e o preenchimento.
- Lotes: nova verificação sem reserva (`checkItems`) e status `dry_run_ok`.

**Revisão final (correções)**
- Perfis com sufixo de idioma (`/in/<slug>/pt`, vindos do `people_search`) agora são aceitos em `connect_prepare`/`message_prepare`; o cache de pessoas guarda a URL normalizada e a busca no cache prefere a linha exata.
- `message_execute`: aceita o botão "Enviar mensagem" sem nome do layout de 2026 quando é o único sem nome e os outros nomeiam outras pessoas (cartões de sugestão); dois sem nome continuam ambíguos.
- Modelos de nota: skill/ferramenta não vira empresa ("Analista de Dados | Python" não gera "…na Python").
- `npm run browser` sempre abre a janela visível (antes abria headless e esperava um login impossível).
- `data_purge` também apaga lotes com mais de N dias (contados em `batches`); um backfill único de `last_seen` impede que a primeira limpeza após a atualização apague linhas vistas recentemente.
- Faixa salarial: "candidate R$ 5.000" não vira mais "até R$ 5.000". Aviso no log para `LINKEDIN_BROWSER` inválido. Nota de reenvio do `message_execute` lembra o `dry_run:false`. `package-lock.json` na versão 0.5.0.
- INSTALL: primeira abertura do Chrome pode levar ~1 min; `BROWSER_EXECUTABLE_PATH` não troca o navegador; use o mesmo `LINKEDIN_BROWSER` no Desktop e no Code.

**Teste ao vivo e pendências da revisão**
- `message_execute`: a bolha de conversa de 2026 abre dentro de um shadow DOM (`#interop-outlet`); leitura do compositor, da conversa e do foco agora entram em shadow roots abertos. Links repetidos para o mesmo destinatário (cartão + cabeçalho fixo) contam como um controle. O "antes" do envio só é lido com o histórico estável (evita falso `done`). Gate de execução extraído e testado (`messageExecutePlan`).
- `people_search`: o campo "Atual" não vira mais empresa embaralhada ("…na área de dados, Salesforce, SAP"); nome de reserva também pelos links do próprio perfil ("Ver perfil de X"); texto de "conexões em comum" reconhecido pela frase inteira.
- Convites: chave de modelo e notas guardadas lidas só como chaves próprias (`Object.hasOwn`); `batch_id` desconhecido dá "Unknown batch_id"; 1º grau com a mesma regra das mensagens.
- `SingletonLock` órfão (Linux/macOS, PID morto) não deixa mais o perfil em `PROFILE_BUSY` para sempre; canal do navegador num só lugar (`config.channel`); `jobs_enrich` usa a lista de erros de conta do ledger.
- `pipeline_stats` respeita `excluded_companies` na análise (`excluded_companies_jobs`); `jobs_watch_*` aparam nomes; `left` documentado.
- Qualidade: `noUnusedLocals`/`noUnusedParameters`; `npm run typecheck` também checa os testes (14 erros de tipo corrigidos); código morto removido; testes mais fortes (leitor do diálogo, fixture de "Pendente", formato do bloqueio de repetição).
- Repositório: licença MIT, `.gitignore` defensivo, `engines` Node >= 24, dados de teste sem nomes reais.

## 0.4.0 — correções pós-teste ao vivo

- **Preenchimento de formulário** (`apply_execute`): resolver + formfill; planeja o passo inteiro antes de tocar na página, relê cada valor, descarta e devolve `needs_answer` quando falta resposta. Registro mascarado por candidatura em `data/applications/<id>.json`.
- **Revisão final**: pergunta de país (autorização/visto), política de skill só para nomes de tecnologia, formação com área, identidade da vaga/diálogo, confirmação de envio em duas leituras, orçamento de tempo dentro do passo, reabertura do item em erro de conta, TTL do lote renovado por item.
- **Convites no layout de 2026**: nome do `<title>` (sem H1), "Conectar" como link `custom-invite`, sucesso só com "Pendente" ou aviso de convite enviado; `diag` em falhas.
- **Teste real**: candidaturas e convites confirmados no LinkedIn.

## 0.4.0 — auditoria e correções

**Candidatura e convites (escrita)**
- Sucesso só após confirmação do LinkedIn; sem confirmação = `unverified` (conta na cota, nunca repete, o `tracker_sync` confirma). Reserva de cota sempre encerrada (try/finally), checkpoint no meio do formulário para o lote preservando resultados.
- Lotes com estado por item: ids validados antes de consumir o lote, sem repetição, continuação com o mesmo `batch_id`; orçamento de tempo por chamada.
- `connect_execute` age só no cartão do perfil-alvo (nunca em sugestões), confere nome/URL, não envia sem a nota aprovada, para no limite semanal; `connect_prepare` valida/normaliza/deduplica e mostra nome/grau/cota.
- Vagas já feitas/em andamento e match Baixo não são oferecidos no `apply_prepare`; revalidação no `apply_execute`.

**Leitura de vagas**
- Login headless abre janela visível só quando necessário; `jobs_search` com `offset`/`next_start`; rastreador não conclui em falso (`stalled`), retoma com cursor; página de vaga vazia não grava; limite de 3 tentativas no `jobs_enrich`; orçamento diário atômico; timeouts de navegação; `posted_at`.
- `jobs_enrich` devolve o que já leu mesmo ao parar por erro de conta.

**Análise e exportação**
- Negação e "diferencial" nas skills, dicionário ampliado e sem aliases ambíguos, idiomas fora das skills, Pendente sem nota, senioridade corrigida. Banco de respostas com cache e erro claro de JSON inválido.
- Planilhas: nome único, cabeçalho em planilha vazia, links http/https clicáveis, células ≤32k, filtros `LIKE` com escape (palavra-chave vazia exporta tudo).
- Mapeador: rótulos de opções reais, e-mail/telefone/nome mascarados, arquivo do `map_page` por query.

**Pessoas e empresas**
- Nova `leads_find_decision_makers` (só leitura). `companies_search`/`companies_enrich` devolvem `company_id` numérico.
- Cache não é mais sobrescrito por campos vazios; página inexistente de empresa não vira linha (`COMPANY_PAGE_NOT_FOUND`); `pairs()` não usa outro rótulo como valor; `splitCurrent` trata "cargo na Empresa em Cidade"; crachás e "Seguindo" fora de headline/local.
- Textos do LinkedIn (pessoas, perfil, empresas, `map_page`) limpos de caracteres invisíveis e cortados.

**Infra**
- `npm test` roda todos os `test/*.test.ts`.

## 0.3.0 — automação real, headless e simplificação

- **Candidatura automática real** (`apply_execute`): automação ponta-a-ponta via Playwright em `src/linkedin/apply.ts`, lidando com multi-etapas, avanço de páginas, detecção de erros de formulário e encerramento limpo via `discardEasyApply`. Atualização real no SQLite (`jobs.applied = 1`).
- **Conexão automática real** (`connect_prepare` e `connect_execute`): automação de envio de convites de conexão em `src/linkedin/people.ts` com suporte opcional a notas de introdução e fechamento de modais.
- **Modo 100% Headless**: configurado `headless: true` em `src/browser/session.ts` para que todas as ações ocorram silenciosamente em plano de fundo sem abrir a janela do navegador na tela do usuário.
- **Planilha simplificada** (`jobs_export_xlsx`): reestruturada para gerar exclusivamente a aba consolidada "Vagas" com todas as métricas detalhadas (Score, Match, Links), eliminando abas excedentes.
- **Análise e match de vagas**: módulos `src/analysis/skills.ts` e `src/analysis/match.ts` com scoring e inferência de senioridade e área.
- Documentação técnica atualizada em `documentos.md` e na pasta `docs/`.

## 0.2.x — revisão com agentes, instalação, vagas externas

**Segurança**
- Edge por pipe em vez de porta de depuração 9222 (qualquer processo local podia assumir a sessão).
- Allowlist `https://www.linkedin.com`; `map_page` sem redirecionadores/logout; `job_id` numérico.
- Instruções do servidor + `{untrusted_text}` contra prompt injection.
- Mapeador: abre só o Easy Apply do `main`, age só no diálogo identificado, botões exatos, descarte verificado em `finally`.
- Ritmo global, orçamento diário de leituras, trava persistente (checkpoint/429/999) + `session_resume`.
- Lotes persistidos, uso único, 30 min; cotas com reserva atômica.

**Correções**
- Caminhos relativos ao cwd (perfil/banco iam parar em outro projeto).
- Fila única para as ferramentas de navegador; corrigido deadlock por chamada aninhada.
- Falso "já candidatado" para "Applied Materials", "Applied Scientist", etc.
- Falso checkpoint ao buscar "challenge"/"login".
- Busca com 1–3 resultados retornava vazio.
- Rastreador: botão "Próxima" sem `aria-label`; parada falsa na página 1; retomada lenta → agora a lista inteira sai em poucas chamadas e a leitura incremental leva segundos.
- Busca marcava todas as vagas como "externas" (rodapé do card carrega depois) → tri-estado `easy_apply` 1/0/desconhecido.
- `max_length` dos campos lido errado; rótulo de opção de rádio vinha "on".
- Strings vazias apagavam dados bons; nome do xlsx em UTC.

**Novidades**
- Vagas de candidatura externa com o link real do ATS (`apply_url`) e `jobs_enrich` em lote.
- Fechamento do Edge após 3 min ocioso e ao sair do app; `PROFILE_BUSY` imediato quando outro app está usando.
- Orçamento de ~30 s por chamada contado desde a fila, com resultados parciais.
- Banco de respostas (`data/answers.json`) com seção `target`: área, modalidade, senioridade, empresas bloqueadas.
- Instalação no Claude Code (escopo usuário) com build em `dist/`.

## 0.1.0 — base e reconhecimento

- Base do servidor MCP (TypeScript, SDK oficial, Playwright, SQLite, exceljs).
- Reconhecimento ao vivo do LinkedIn: busca de vagas (Ember), detalhe da vaga, pessoas, empresas, perfil, "Sobre", rastreador de candidaturas, formulários Easy Apply — ver [MAPPING.md](MAPPING.md).
- Extratores de vagas, pessoas, empresas e rastreador; mapeadores somente leitura.
