# Planilha de análise de vagas

Gerada por `jobs_export_xlsx` em `<dados>/exports/vagas-AAAAMMDD-HHMMSS.xlsx` (horário de São Paulo; nunca sobrescreve). Código: `src/export/jobsReport.ts`, `src/analysis/match.ts`, `src/analysis/skills.ts`.

> Rode `jobs_enrich` antes de exportar. Sem descrição, a vaga só tem o título e fica como **Pendente**.

## Estrutura da Planilha (Aba Única: Vagas)

Para facilitar a leitura e evitar excesso de abas no Excel, a exportação foi simplificada para conter exclusivamente a aba consolidada **"Vagas"**, ordenada pelo melhor match (Alto → Médio → Baixo → Pendente, seguido por score decrescente):

| Coluna | Origem |
|---|---|
| Match | Alto / Médio / Baixo / Pendente (com cor verde / amarelo / vermelho / cinza) |
| Score (0-100) | 70% cobertura de skills + 30% senioridade |
| Empresa, Cargo | card da busca / página da vaga |
| Área | inferida pelo cargo (ver abaixo) |
| Senioridade | inferida pelo cargo e descrição |
| Senioridade compatível | Sim / Parcial / Não, comparando com `target.seniority` do `answers.json` |
| Cobertura de skills (%) | skills da vaga que você tem ÷ skills que a vaga pede |
| Nº skills pedidas | quantas skills do dicionário apareceram na vaga |
| Skills que você tem / que faltam / todas | listas separadas por vírgula |
| Modalidade | Remoto / Híbrido / Presencial |
| Local | sem o sufixo de modalidade |
| Tipo de contrato | Tempo integral, Meio período, Contrato, Estágio… |
| Candidatos | texto do LinkedIn ("59 candidaturas", "Mais de 100 pessoas clicaram") |
| Publicada | "há 5 dias" etc. |
| Tipo de candidatura | Candidatura simplificada / Site da empresa / Desconhecido |
| Já me candidatei, Encerrada | Sim / Não |
| Link da vaga, Link de candidatura, Página da empresa | hyperlinks clicáveis; o link de candidatura é o ATS real |
| Requisitos do anunciante | bullets "Requisitos adicionados pelo anunciante" |
| Anos de experiência exigidos | número lido da descrição/requisitos (PT-BR e EN); vazio se o texto não cita |
| Faixa salarial | faixa citada na descrição, normalizada; vazio se não cita |
| Busca de origem | palavra-chave da busca que encontrou a vaga |
| Base da análise | Descrição completa / Só título |
| Visto em, ID da vaga | metadados |

## Regras do match

| Nível | Regra |
|---|---|
| **Alto** | senioridade compatível **e** você tem ≥ 60% das skills da vaga **e** pelo menos 3 skills encontradas |
| **Médio** | senioridade compatível ou parcial **e** ≥ 35% das skills |
| **Baixo** | o resto — inclui Sênior/Especialista/Liderança quando seu alvo é Júnior/Pleno |
| **Pendente** | só o título é conhecido (sem descrição/requisitos). Exceção: se o título já mostra senioridade incompatível, vira Baixo |

**Senioridade compatível**: `Sim` se o nível está no seu alvo; `Parcial` se é Não informado, Estágio ou Trainee; `Não` caso contrário.
Seu alvo vem de `target.seniority` em `<dados>/answers.json` (`entry` → Júnior/Trainee, `associate` → Pleno, `senior` → Sênior/Especialista, `director` → Liderança, `internship` → Estágio).

## Senioridade (inferência)

Pelo cargo, nesta ordem: Estágio (estágio, estagiário, intern) → Trainee → Liderança (head, gerente, manager, coordenador, líder, lead, diretor, supervisor) → Especialista (especialista, specialist, principal, staff) → Sênior (sênior, sr, III) → Pleno (pleno, pl, mid, II) → Júnior (júnior, jr, entry, I). Se o cargo não diz, procura "vaga/nível/perfil júnior|pleno|sênior" na descrição. Senão: **Não informado**.

## Área (inferência pelo cargo)

Engenharia de Dados · Ciência de Dados / IA · Análise de Dados / BI · Desenvolvimento · Produto · Finanças · Marketing / Growth · Operações / Logística · Outros.

## Skills

- **Dicionário** (`src/analysis/skills.ts`): ~40 skills canônicas com sinônimos (SQL, Python, Excel, Power BI, DAX, Power Query, Tableau, Looker, Qlik, ETL, modelagem de dados, Databricks, Spark/PySpark, Airflow, dbt, Snowflake, BigQuery, Azure, AWS, GCP, OCI, Git, Power Automate, APIs, Estatística, Machine Learning, IA/LLMs, SAP, Salesforce, Google Analytics, Agile/Scrum, Inglês, Espanhol…). A busca é por palavra inteira, sem acento e sem maiúsculas.
- **Suas skills**: as `aliases` de `skills[]` no `answers.json` passadas pelo mesmo dicionário. Inglês/Espanhol contam como "tem" só se o nível for avançado, fluente ou nativo.
- **Texto analisado**: cargo + descrição + requisitos do anunciante.

### Ajustar

- Skill nova do mercado → adicione em `SKILLS` (`src/analysis/skills.ts`), `npm run build`, reinicie o app.
- Skill que você tem e não aparece como "tem" → adicione um alias em `skills[]` do `answers.json` (não precisa build).
- Mudar limiares (60% / 35% / 3 skills) → `analyzeJob` em `src/analysis/match.ts`.

## Outras planilhas

- `people_export_xlsx`: nome, headline, cargo, empresa, local, grau, URL.
- `leads_export_xlsx`: nome, setor, tamanho, site, local, URL.
