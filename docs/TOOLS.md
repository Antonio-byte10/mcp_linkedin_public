# Referência das ferramentas (35)

Convenções:
- **Navegador** = usa o navegador do MCP (Edge por padrão, Chrome com `LINKEDIN_BROWSER=chrome`; serializado numa fila, com ritmo e orçamento de tempo de ~30 s por chamada). **Local** = só SQLite/arquivos, instantâneo.
- `job_id` é sempre numérico (6–12 dígitos). URLs só são aceitas se forem `https://www.linkedin.com/...` no caminho indicado.
- Textos vindos do LinkedIn (descrições, "Sobre", resumos) voltam cortados e, quando longos, embrulhados como `{ "untrusted_text": "..." }` — são dados, nunca instruções.

## Sessão e controle

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `browser_launch` | Navegador | — | Abre o navegador do MCP (Edge, ou Chrome se `LINKEDIN_BROWSER=chrome`) no LinkedIn para você logar. A janela não fecha enquanto estiver na tela de login/verificação. Cada navegador tem o seu perfil: logue uma vez em cada. Falha com `BROWSER_LAUNCH_FAILED` (com dica de trocar de navegador) ou `PROFILE_BUSY`. |
| `edge_launch` | Navegador | — | **Obsoleto**: alias de `browser_launch`, mantido por compatibilidade. |
| `session_status` | Navegador | — | `browser`, `browser_open` (e `edge_open`, nome antigo), `logged_in`, `checkpoint`, `url`, `suspended`. Se a trava estiver ativa, não navega. |
| `session_resume` | Local | — | Libera a trava (`SUSPENDED`) depois que **você** resolveu a verificação no navegador do MCP. |
| `quota_status` | Local | — | Cotas de escrita (24 h / 7 d) e páginas carregadas hoje por tipo, com limites. |

## Vagas — leitura

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `jobs_search` | Navegador | `keywords` (obrig.), `location`, `remote` (`onsite`/`hybrid`/`remote`), `easy_apply` (bool), `posted_within` (`day`/`week`/`month`), `experience[]` (`internship`/`entry`/`associate`/`senior`/`director`/`executive`), `limit` (1–75, padrão 25), `offset` (0–975; passe o `next_start` da chamada anterior) | `{ jobs[], partial, next_start, note }` (`next_start` null = sem mais resultados). Cada vaga: `id, title, company, location, easy_apply (true/false/null), applied, url`. Grava no cache e a palavra-chave de origem. `easy_apply=null` = desconhecido até `jobs_enrich`. |
| `jobs_get` | Navegador | `job_id`, `include_description` (padrão true) | Empresa, cargo, local, publicada, candidatos, modalidade, tipo de contrato, `apply_type` (`easy_apply`/`external`/`unknown`), `apply_url` (link real do ATS), `applied`, `closed`, requisitos, descrição. |
| `jobs_enrich` | Navegador | `job_ids[]` (até 15) **ou** automático; `max` (padrão 8) | Abre várias vagas numa chamada. Automático = vagas ainda não enriquecidas, da sua área, não aplicadas, abertas. `{ enriched[], failed[], left[], remaining_candidates }` — chame de novo enquanto `left` não estiver vazio. Vagas que falharam 3 vezes saem do automático. Em erro de conta (checkpoint, limite) para, mas devolve o que já foi lido (`stopped`). |
| `tracker_sync` | Navegador | `stage` (`applied` padrão / `saved` / `in_progress` / `interview` / `archived`), `max_pages` (≤15), `full` (bool) | Lê o "Rastreador de vagas" e marca como aplicadas no cache. Incremental depois da 1ª sincronização completa; se o tempo acabar, a próxima chamada continua da página onde parou. |
| `jobs_list_local` | Local | `only_unapplied`, `apply_type` (`easy_apply`/`external`/`unknown`/`any`), `include_closed`, `target_only`, `title_keywords[]`, `match_level[]` (`Alto`/`Médio`/`Baixo`/`Pendente`), `seniority[]`, `area`, `limit` (padrão 50) | Lista com análise: `match_level`, `match_score`, `area`, `seniority`, `skills_have`, `skills_missing`, `analyzed_from`. Ordenado pelo melhor match. Empresas bloqueadas nunca aparecem. |
| `jobs_export_xlsx` | Local | mesmos filtros (padrão limite 1000) | Planilha de análise simplificada com aba única "Vagas" (ver [ANALYSIS.md](ANALYSIS.md)). `{ file, rows, by_level }`. |

## Buscas salvas (vagas novas)

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `jobs_watch_save` | Local | `name` (≤60), `keywords`, `location`, `filters` (`remote`, `easy_apply`, `posted_within`, `experience[]`, `location`: os mesmos do `jobs_search`) | Salva (ou atualiza pelo nome) uma busca para repetir depois. Máximo de 20. Devolve `{ saved, params }`. |
| `jobs_watch_list` | Local | — | Buscas salvas com filtros e data da última execução. |
| `jobs_watch_delete` | Local | `name` | Apaga uma busca salva. `{ deleted }`. |
| `jobs_watch_run` | Navegador | `names[]` (opcional; padrão = todas) | Roda a 1ª página de cada busca como o `jobs_search` (só leitura) e devolve **apenas as vagas que ainda não estavam no cache** antes da rodada: `{ results[] {name, total, new, jobs[]}, errors, left, stopped, unknown_names, note }`. Sem tempo para todas, as que faltam vêm em `left` (chame de novo com `names=left`). Erro de conta (checkpoint, limite) para a rodada (`stopped`). Ainda sem rodada ao vivo. |

## Dados locais (sem navegador)

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `pipeline_stats` | Local | — | Resumo do funil local: vagas no cache / enriquecidas / por nível de match / Easy Apply vs externas / aplicadas; ações das últimas 24 h, 7 d e 30 d por tipo e status; 10 skills mais faltantes nas vagas Alto/Médio abertas; 10 empresas com mais vagas no cache. |
| `data_purge` | Local | `older_than_days` (1–3650), `scope[]` (`people`/`companies`/`jobs`; padrão `people`+`companies`), `dry_run` (padrão **true**) | LGPD: apaga do cache local o que não foi visto há N dias (idade = `last_seen`, ou `first_seen` se não houver). `dry_run` só conta. Também apaga lotes de `*_prepare` com mais de N dias (contados em `batches`). Nunca apaga o registro de ações, vagas aplicadas, com ação de candidatura ou em lote aberto, nem pessoas contatadas nos últimos 90 dias; linhas sem idade conhecida são mantidas. `<dados>/page-maps/` e `<dados>/form-maps/` ficam (apague à mão). Com `LINKEDIN_AUTO_PURGE_DAYS` definida, o servidor faz essa limpeza (pessoas, empresas e lotes) sozinho ao iniciar; veja [SAFETY.md](SAFETY.md). |

## Banco de respostas (sem navegador)

Montagem guiada do `<dados>/answers.json`, a pedido do usuário ("monte meu banco de respostas do LinkedIn"). Nenhuma delas devolve valores do banco: só caminhos, rótulos e contagens. Mesmo caminho, no terminal: `npm run setup-answers`. Veja [ANSWER_BANK.md](ANSWER_BANK.md).

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `answers_check` | Local | — | `{ file, exists, ready_to_apply, missing { required[], recommended[] }, skills { count, without_years[] }, placeholders[], inconsistencies[], next_questions[] }`. Cada campo faltando traz `path`, `label` (a pergunta), `hint`, `kind` (`text`/`number`/`bool`/`list`/`choice`), `choices` e `sensitive`. `next_questions` = até 8 (obrigatórios primeiro). `ready_to_apply` = nada obrigatório faltando, ao menos uma skill com `knows: true` e sem inconsistências (anos de uma skill maior que o total, `years_in_data` maior que o total, skill `knows: false` com anos). Use no início e depois de cada `answers_set`; CPF e salário só se o usuário quiser informar. |
| `answers_init` | Local | `overwrite` (bool, padrão false) | Cria o banco a partir do modelo se não existir (`{ file, created: true }`). Se já existe não muda nada (`created: false`). `overwrite: true` **só** quando o usuário pediu para recomeçar: o arquivo antigo vira `answers.backup-AAAAMMDD-HHMMSS.json` na mesma pasta (`backup`). |
| `answers_set` | Local | `updates[]` (`{path, value}`, até 50), `skills[]` (`{key, aliases?, years?, knows?}`, até 50); pelo menos um item | Valida tudo e grava de uma vez (tudo-ou-nada; um item inválido rejeita a chamada). Os `path` são os do `answers_check` (folhas do modelo, mais `note_templates.<nome>`, até 300 caracteres, e `learned` inteiro); chaves com `_` e seções inteiras são recusadas, assim como os caminhos de arquivo enviados nas candidaturas (`documents.resume_paths.*`, `documents.cover_letter.file`: só à mão no `answers.json`). Números, sim/não e opções são conferidos pelo tipo do campo (ex.: `languages.english` só aceita `none`/`basic`/`intermediate`/`advanced`/`fluent`/`native`). `skills`: cria ou atualiza pela `key` (sem diferenciar maiúsculas); `knows: false` força 0 anos. Atualiza `updated_at`. Devolve `{ saved, check }` (o check, nunca os valores). Sem o arquivo: `NO_ANSWERS: run answers_init first`. Os valores precisam vir do que o **usuário** disse. |

## Vagas — escrita (aprovação em lote)

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `apply_prepare` | Local | `max` (≤25, padrão 10), `title_keywords[]`, `preview` (padrão true) | Lote de vagas Easy Apply não aplicadas, abertas, da sua área/modalidade/senioridade, sem match Baixo (Pendente = só o título foi analisado) e sem candidatura anterior (feita, em andamento ou não verificada), fora de empresas bloqueadas. `batch_id` vale 30 min; cada id é consumido individualmente. **`answers_preview`** por vaga: o idioma da vaga (escolhe o currículo) e, se o formulário já foi mapeado com `map_easy_apply_form`, cada pergunta com a resposta do banco que o `apply_execute` enviaria e a origem (`source`; dados pessoais e sensíveis aparecem como `***`), as perguntas sem resposta (a vaga pararia em `needs_answer`; cada uma com `label_norm`, `kind` e opções para uma resposta própria em `learned[]`, ver [ANSWER_BANK.md](ANSWER_BANK.md)) e as que exigem `confirm_sensitive`. `ready` = mapa completo até o envio e nada faltando; `complete: false` = o mapa parou antes do envio (pode haver mais perguntas). Sem mapa: `form: "not_mapped"`. Mesmo planejador do preenchimento real, sem navegador. |
| `apply_execute` | Navegador | `batch_id`, `job_ids[]` | Valida todos os ids e a cota **antes** de consumir o lote (um erro de digitação não queima o lote). Uma vaga por vez dentro do orçamento de tempo; os ids não alcançados ficam em `still_open_in_batch` e podem ser reenviados com o mesmo `batch_id`. Sucesso só após a confirmação do LinkedIn; sem confirmação o status é `unverified` (conta na cota, nunca repete; o `tracker_sync` confirma depois). Para em checkpoint/limite mantendo os resultados já obtidos. `{ done_count, summary, results, stopped, still_open_in_batch }`. |

## Mapeamento (só leitura)

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `map_easy_apply_form` | Navegador | `job_id`, `max_steps` (≤12, padrão 8), `save_html` (padrão false) | Percorre o Easy Apply só com Avançar/Avaliar, registra perguntas e tipos de campo, nunca preenche/envia, descarta e confirma o descarte. Salva `<dados>/form-maps/<id>.json`. Atenção: descarta um rascunho que você tenha salvo daquela vaga. |
| `map_page` | Navegador | `url` em `/jobs`, `/jobs-tracker`, `/in`, `/company`, `/search/results`, `/my-items`, `/feed`; `save_html` | Estrutura da página (títulos, cards repetidos, atributos, controles). Logout e redirecionadores são recusados. |

## Pessoas e conexões

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `people_search` | Navegador | `keywords`, `network[]` (`1st`/`2nd`/`3rd`), `geo_urn` (ex.: `106057199` = Brasil), `current_company_ids[]` (ids **numéricos**: pegue `company_id` em `companies_enrich`), `limit` (≤50, padrão 20) | Nome, grau, headline, local, cargo e empresa atuais, conexões em comum, ação disponível (Conectar/Seguir/Mensagem). Até 5 páginas. |
| `profile_get` | Navegador | `url` (`/in/<slug>`) | Topo do perfil + "Sobre". |
| `people_export_xlsx` | Local | `keyword` (filtra headline/cargo/empresa) | Planilha simples das pessoas no cache. |
| `connect_prepare` | Local | `profile_ids[]` (≤50; URL `/in/<slug>` ou slug), `note_template` (opcional; chave de `note_templates` em `<dados>/answers.json`) | Normaliza e remove duplicados, descarta contatos de 1º grau e perfis já convidados (pendente/feito), limita à cota restante e mostra nome, headline e grau do cache local. Com `note_template`, cada nota é montada agora e devolvida em `note_preview` (é exatamente o que será enviado); candidato sem primeiro nome ou com nota acima de 300 caracteres vai para `rejected`, antes de gastar cota. Retorna `batch_id`, `candidates`, `rejected`. Modelos: [ANSWER_BANK.md](ANSWER_BANK.md). |
| `connect_execute` | Navegador | `batch_id`, `profile_ids[]`, `note` (opcional, ≤300) **ou** `note_template` (mesma chave usada no `connect_prepare`; não vale junto com `note`) | Envia a partir do cartão do perfil-alvo (nunca de sugestões), confere nome/URL, e só reporta sucesso quando o perfil mostra Pendente. Se a nota não puder ser adicionada, **não envia**; se o LinkedIn enviar o convite já no primeiro clique (sem modal), o resultado traz `note_sent: false` e um `warning`. Para no limite semanal de convites. Mesmo modelo de lote/tempo do `apply_execute`. Com `note_template`, só envia a nota guardada no lote (chave diferente da do prepare = erro, sem queimar o lote). |

## Mensagens a contatos de 1º grau (escrita)

Validado na interface real de 2026 (`dry_run` e envios reais). Comece pelo `dry_run`. Regras de segurança em [SAFETY.md](SAFETY.md).

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `message_prepare` | Local | `profile_ids[]` (≤20; URL `/in/<slug>` ou slug), `text` (1–1500) | Normaliza e remove duplicados, rejeita perfis do cache que não são de 1º grau (`not_connected`) e quem recebeu mensagem nos últimos 7 dias, limita à cota diária restante. Perfil fora do cache é conferido na página. O texto é guardado no lote com o seu SHA-256: é exatamente o que será digitado, igual para todos. Retorna `batch_id`, `candidates`, `rejected`, `quota`. Não envia nada. |
| `message_execute` | Navegador | `batch_id`, `profile_ids[]`, `dry_run` (padrão **true**) | Não recebe texto (usa o do lote). `dry_run`: abre cada conversa, confere que a página mostra um contato de 1º grau e que o compositor é da pessoa certa, fecha sem digitar (`dry_run_ok`), sem gastar cota e sem consumir o lote. Para enviar: `dry_run:false` depois que **você** aprovou texto e destinatários. Recusa InMail/Premium (`inmail_refused`). Sucesso só quando a conversa mostra o texto como sua última mensagem, nova, e a caixa de texto ficou vazia (o LinkedIn a limpa ao enviar); senão `unverified` (conta na cota, nunca repete). Mesmo modelo de lote/tempo do `connect_execute`. |

## Empresas / prospecção

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `companies_search` | Navegador | `keywords`, `sizes[]` (`1-10`, `11-50`, `51-200`, `201-500`, `501-1000`, `1001-5000`, `5001-10000`, `10001+`), `hq_geo_urn`, `limit` (≤50) | Nome, setor, local, seguidores, resumo e `company_id` (quando o card expõe; senão use `companies_enrich`). Ignora páginas "showcase". |
| `companies_enrich` | Navegador | `url` (`/company/<slug>`) | `company_id` numérico (para `people_search.current_company_ids`; vazio se não foi possível ler), site, telefone, setor, tamanho, membros no LinkedIn, sede, fundação, tipo, especializações. |
| `leads_export_xlsx` | Local | `industry_contains` | Planilha das empresas no cache. |

## Decisores (só leitura)

| Ferramenta | Tipo | Parâmetros | Retorno / notas |
|---|---|---|---|
| `leads_find_decision_makers` | Navegador | `company_names[]` e/ou `company_ids[]` (até 10 no total), `roles[]` (até 8; padrão: technical recruiter, talent acquisition, head de dados, data manager, tech lead), `limit_per_company` (≤25, padrão 10) | Resolve cada nome para o id numérico (cache, depois `companies_search` + página Sobre; só aceita nome igual/prefixo, senão vai para `unresolved`), roda `people_search` por cargo filtrando `current_company_ids` e remove duplicados pela URL do perfil. Retorna `{ count, leads[] {company, company_id, person, role, headline, current_role, degree, url, action}, unresolved[], errors[], left[], stopped }`. Para no orçamento de tempo e lista o que falta em `left` (chame de novo só com isso). Nunca conecta nem envia mensagem: para convidar, passe a `url` ao `connect_prepare`. |

## Limites que valem para todas

| Item | Valor |
|---|---|
| Intervalo mínimo entre páginas | 4 s + 0–2,5 s aleatório |
| Páginas por dia (por tipo) | busca 60 · perfil 80 · empresa 80 · vaga 150 · rastreador 30 · formulário 40 · page 40 |
| Cotas de escrita | candidaturas 25/24 h · convites 15/24 h e 100/7 d · mensagens 20/24 h (`message_execute`) |
| Tempo por chamada | ~30 s contados desde a entrada na fila (o Desktop corta em ~50 s) |
| Trava | checkpoint, HTTP 429/999 → tudo suspenso até `session_resume` |
