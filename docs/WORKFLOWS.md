# Fluxos de uso

Exemplos de pedidos em linguagem natural para o Claude (Desktop ou Code). Entre parênteses, as ferramentas que ele vai usar.

> Chamadas longas são divididas: se aparecer "call again" / "left", o Claude chama de novo e continua de onde parou. Isso é normal e protege contra o limite de ~50 s do Desktop.

## Primeiro uso: montar o banco de respostas

> "Monte meu banco de respostas do LinkedIn."

1. `answers_check` — vê o que existe e o que falta (sem mostrar valores).
2. `answers_init` — cria o `<dados>/answers.json` a partir do modelo, se ainda não existir (nunca sobrescreve; `overwrite: true` só se você pedir para recomeçar, com backup).
3. O Claude pergunta, algumas perguntas por vez, o que falta (`next_questions`) e grava as suas respostas com `answers_set`; depois de cada gravação repete o `answers_check`, até `ready_to_apply: true`. Skills entram com os anos de uso de cada uma.

Prefere o terminal? `npm run setup-answers` faz as mesmas perguntas, uma por vez, e retoma de onde parou. Detalhes e regras de segurança: [ANSWER_BANK.md](ANSWER_BANK.md).

## 1. Planilha de análise de vagas

> "Pesquise vagas de analista de dados júnior e de BI, remotas e híbridas em SP, enriqueça os detalhes e gere a planilha."

1. `jobs_search` — uma vez por palavra-chave/filtro (ex.: "analista de dados", "business intelligence", "power bi").
2. `tracker_sync` — marca as vagas em que você já se candidatou (fonte da verdade).
3. `jobs_enrich` — repetido até `left` ficar vazio; abre cada vaga e traz descrição, requisitos, modalidade, contrato, candidatos e o link real de candidatura.
4. `jobs_export_xlsx` — gera `<dados>/exports/vagas-AAAAMMDD-HHMMSS.xlsx`.

Detalhes das colunas e das regras de match: [ANALYSIS.md](ANALYSIS.md).

Dicas:
- Quanto mais `jobs_enrich`, menos vagas ficam como **Pendente** (só título).
- Filtros úteis no export: `only_unapplied: true`, `target_only: true`, `match_level: ["Alto","Médio"]`, `seniority: ["Júnior","Pleno"]`, `area: "Dados"`.

## 2. Vagas para se candidatar manualmente (site da empresa)

> "Liste as vagas da minha área em que eu ainda não me candidatei e que são no site da empresa, com o link."

`jobs_search` → `jobs_enrich` → `jobs_list_local { only_unapplied, apply_type: "external", target_only }`.
O campo `apply_url` é o link real do ATS (Greenhouse, Gupy, Inhire, Ashby…), já sem o redirecionador do LinkedIn.

## 3. Vagas de candidatura simplificada (Easy Apply)

> "Quais vagas de candidatura simplificada com match alto ou médio eu ainda não apliquei?"

`tracker_sync` → `jobs_list_local { only_unapplied, apply_type: "easy_apply", target_only }` → `apply_prepare`.

`apply_prepare` devolve um **lote** (válido por 30 min) só com vagas Alto/Médio, da sua área, não aplicadas, fora de empresas bloqueadas. Você escolhe quais; `apply_execute` só aceita IDs desse lote e preenche cada formulário com o seu `answers.json`.

**Ver as respostas antes de aprovar** (opcional, recomendado na primeira vez numa empresa):

> "Mapeie o formulário da vaga 3000000004 e me mostre o que seria respondido."

`map_easy_apply_form { job_id }` (só leitura: percorre e descarta) → `apply_prepare`. Cada candidata traz `answers_preview`: o que cada pergunta receberia e de onde vem a resposta, o que falta no banco (`unanswered`) e o que exige `confirm_sensitive` (CPF, salário). `ready: true` = nada faltando até o envio. Para o que falta, complete o `answers.json` e rode `apply_prepare` de novo.

## 4. Pessoas-chave

> "Encontre heads de dados e tech recruiters em São Paulo, conexões de 2º grau."

`people_search { keywords, network: ["2nd"], geo_urn: "106057199" }` → `profile_get` para detalhes → `people_export_xlsx`.

## 5. Prospecção B2B

> "Encontre clínicas odontológicas de 11 a 200 funcionários no Brasil e me dê site e telefone."

`companies_search { keywords, sizes: ["11-50","51-200"], hq_geo_urn: "106057199" }` → `companies_enrich` em cada uma → `leads_export_xlsx`.

## 6. Estudar uma página / formulário (só leitura)

- `map_page { url }` — estrutura de uma página do LinkedIn (para ajustar extratores).
- `map_easy_apply_form { job_id }` — abre o Easy Apply, percorre as etapas com Avançar/Avaliar, registra cada pergunta e tipo de campo, **nunca preenche nem envia**, e descarta. Resultado em `<dados>/form-maps/<id>.json`.

## 7. Manutenção

| Pedido | Ferramenta |
|---|---|
| "O LinkedIn está logado?" | `session_status` |
| "Quanto ainda posso usar hoje?" | `quota_status` |
| "Resolvi a verificação, pode continuar" | `session_resume` |
| "Sincronize tudo do zero" | `tracker_sync { full: true }` |

## Limpar o cache

Feche os apps que usam o MCP e apague `<dados>/linkedin.db*` e `<dados>/exports/`. **Não** apague `<dados>/answers.json` (suas respostas) nem `<dados>/edge-profile/` / `<dados>/chrome-profile/` (seu login).
