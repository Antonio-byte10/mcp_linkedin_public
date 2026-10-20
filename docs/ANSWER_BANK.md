# Banco de respostas — `<dados>/answers.json`

Arquivo **local**, na pasta de dados (`%LOCALAPPDATA%\mcp-linkedin`, fora da pasta do código) com suas respostas para formulários de candidatura e suas preferências de vaga. Modelo vazio: [answers.template.json](answers.template.json).

> Contém dados pessoais (CPF, salário, telefone). Não compartilhe, não sincronize em nuvem pública.

## Criar o seu banco

Você não precisa copiar o modelo nem editar JSON à mão. Há dois caminhos guiados, e os dois escrevem em `<dados>/answers.json` (a pasta de dados, **nunca** o repositório):

1. **Pelo Claude**: peça *"monte meu banco de respostas do LinkedIn"*. Ele roda `answers_check` (o que falta), `answers_init` (cria o arquivo a partir do modelo) e faz as perguntas em linguagem simples, algumas por vez; cada resposta sua é gravada com `answers_set`. Só entra no banco o que **você** disser na conversa: o Claude não chuta nem copia texto de páginas do LinkedIn. CPF e pretensão salarial só se você quiser informar.
2. **Pelo terminal**: `npm run setup-answers`. Um assistente faz uma pergunta por vez (Enter vazio pula), grava depois de **cada** resposta (se você fechar no meio, o que já respondeu fica) e, no fim, mostra o que ainda falta. Rodar de novo retoma de onde parou e só pergunta o que está em branco.

**O que é conferido** (`answers_check`, o mesmo critério do assistente): campos **obrigatórios** para o `apply_execute` (nome, e-mail, telefone, cidade, anos de experiência, mobilidade, cargos e senioridade procurados, idiomas, currículos, consentimentos), **recomendados** (LinkedIn, cargo atual, anos em dados, curso, aviso prévio, apresentação curta), `<...>` do modelo que sobraram (ex.: `target.hybrid_area`) e inconsistências (anos de uma skill maiores que o total, `years_in_data` maior que o total, skill `knows: false` com anos). `ready_to_apply` só fica `true` com nada obrigatório faltando, ao menos uma skill com `knows: true` e nenhuma inconsistência. O resultado traz caminhos e rótulos, **nunca** os valores guardados. O modelo vem sem cargos, senioridade, modalidades nem skills: o assistente (ou o Claude) pergunta cada um.

**Regras de segurança do arquivo**:
- **Nunca sobrescreve.** Se o `answers.json` já existe, `answers_init` e o assistente não mudam nada.
- Para recomeçar do zero é preciso pedir (`answers_init` com `overwrite: true`): o arquivo antigo é guardado ao lado como `answers.backup-AAAAMMDD-HHMMSS.json` antes de o modelo novo ser gravado.
- Toda gravação é validada (campo existe no modelo, tipo e opções corretos) e é tudo-ou-nada: se um item é inválido, nada é gravado. A escrita é atômica (arquivo temporário e renomeação).
- **Caminhos de arquivo só à mão.** `answers_set` e o assistente recusam `documents.resume_paths.pt`, `documents.resume_paths.en` e `documents.cover_letter.file`: são caminhos de arquivos para envio, e quem escolhe o que sai do seu computador é você, editando o `answers.json` à mão (o Claude nunca escolhe). Upload de arquivo: se o formulário pede um currículo em campo de arquivo (e não numa lista de currículos salvos), o `apply_execute` envia o arquivo do caminho `documents.resume_paths.<idioma>` do seu `answers.json`; sem esse caminho a vaga volta em `needs_answer` (`no_bank_value:documents.resume_paths`), e campo de arquivo opcional fica em branco. Esse caminho ainda não foi exercitado numa candidatura real.
- Mesmo assim, editar o JSON à mão continua valendo (veja as seções abaixo); a próxima chamada já usa a edição.

## Quem usa

| Parte do código | Usa |
|---|---|
| Filtros de vaga (`src/answers/bank.ts`) | `target.*` |
| Análise de match (`src/analysis/match.ts`) | `skills[]`, `languages`, `target.seniority` |
| Notas de convite (`connect_prepare` / `connect_execute`, via `src/linkedin/noteTemplate.ts`) | `note_templates` |
| Candidatura em lote (`apply_execute`, via `src/answers/resolver.ts` + `src/linkedin/formfill.ts`) | todo o resto |

Mudanças no `answers.json` valem na próxima chamada — **não precisa** rebuild.

## Seções

### `policy`
| Campo | Valor atual | Significado |
|---|---|---|
| `unmatched_required` | `stop_and_ask` | Pergunta obrigatória desconhecida: para e pergunta, nunca chuta |
| `unmatched_optional` | `leave_and_report` | Opcional desconhecida: deixa em branco e avisa |
| `skills_not_listed` | `zero_years_and_no` | Skill fora da sua lista = 0 anos / Não (verdadeiro, pois a lista é o que você sabe) |
| `prefill_without_bank_entry` | `stop_and_ask` | Valor que o LinkedIn pré-preencheu sem equivalente no banco: pergunta |
| `save_new_answers` | `on_explicit_approval` | Resposta nova só entra no banco se você pedir |
| `submit` | `after_batch_approval` | Envia depois que você aprova o lote |
| `sensitive_confirmation` | `once` | Dados sensíveis confirmados uma vez só |

### `note_templates` — notas de convite
Mapa `chave → texto` usado por `connect_prepare(note_template: "<chave>")`. O `connect_prepare` monta a nota de cada pessoa (veja `note_preview`) e o `connect_execute` envia exatamente aquele texto, com a mesma chave. Não vale junto com `note`.

| Regra | Efeito |
|---|---|
| Marcadores `{first_name}`, `{company}`, `{role}` | Vêm do cache da pessoa. Cargo e empresa saem do headline em formas como "Cargo at/na/no/em Empresa", "Cargo / Empresa" (com barra vertical) ou "Cargo @ Empresa" |
| `[trecho opcional]` | O trecho entre colchetes só entra se todos os marcadores dentro dele puderem ser preenchidos; senão é descartado inteiro |
| Marcador fora de colchetes que não pode ser preenchido (`{company}`/`{role}`) | A frase inteira (até `.`, `!`, `?` ou quebra de linha) é descartada |
| Sem primeiro nome | A pessoa é rejeitada (`rejected`) |
| `NOTE_MAX` = 300 caracteres após montar | Acima disso a pessoa é rejeitada, antes de gastar cota |

O texto da nota é seu; os valores vindos do LinkedIn são limpos (caracteres invisíveis, `{}` e `[]` removidos). O modelo traz dois exemplos neutros em [answers.template.json](answers.template.json) (`geral`, `recrutador`); troque pelos seus ou crie novas chaves. Mudanças valem na próxima chamada.

### `target` — que vagas interessam
| Campo | Uso |
|---|---|
| `include_titles` | Palavras (palavra inteira) que o cargo precisa ter. Lista vazia = qualquer título serve. Exemplo (de quem busca vagas em dados): dados, data, bi, analytics, power bi… |
| `exclude_titles` | Palavras que eliminam a vaga |
| `seniority` | `entry` (Júnior/Trainee), `associate` (Pleno)… — filtra vagas Sênior/Liderança do lote e entra no match |
| `modalities` | `remote`, `hybrid` (sem `onsite` = presencial nunca é oferecido) |
| `hybrid_area` | Cidades onde híbrido é aceito (Campinas, Jundiaí, São Paulo, SP…) |
| `excluded_companies` | **Nunca** aparecem em listas, lotes ou planilhas (ex.: empregador atual) |

### `profile`
Nome, e-mail, telefone (código do país + número), cidade (pt/en + texto para o campo de cidade com sugestões), LinkedIn, portfólio, GitHub, empregador e cargo atuais, anos de experiência (total e em dados), CPF.

### `mobility`
Remoto (inclusive exterior), híbrido, presencial, realocação e destinos, cidadanias, países onde pode trabalhar, necessidade de visto por região. Pergunta de presencial só alguns dias por semana ("presencialmente 3x por semana", "2 dias na semana", "three days a week") é tratada como híbrido (`accepts_hybrid`) e só recebe Sim quando o lugar da pergunta ou da vaga está em `target.hybrid_area`; fora dela a vaga para em `needs_answer` (`hybrid_outside_hybrid_area`). "Trabalhar híbrido no escritório X" também é híbrido. Uma pergunta que, além da disponibilidade, afirma onde você mora ("Reside em Exemplópolis e tem disponibilidade…") nunca é respondida sozinha (`residence_in_question`). "Em qual país você mora?" usa o país da sua cidade em `profile.location_city`.

### `skills[]`
O modelo vem com a lista vazia: as skills entram pelo assistente ou pelo `answers_set` (`skills`). Cada item: `key`, `aliases` (como aparecem nas vagas, pt/en), `years` (anos para "Há quantos anos você usa X?"), `knows` (Sim/Não para "Você tem conhecimento de X?"). Listas com "ou" ("Power BI ou Looker Studio", "one of the following: SQL, Python, or R"): Sim quando você conhece qualquer uma; 0 anos / Não quando nenhuma está na lista e todas são nomes de ferramenta. "e"/"and" nunca divide a lista, e uma pergunta de anos com uma ferramenta conhecida e outra não fica sem resposta (não há um número só que seja verdadeiro).

### `education`
Situação do ensino superior (`technologist_complete`…), curso e instituição, níveis concluídos, certificações (nome, emissor, data).

### `languages`
Nível (`basic`…`native`) e o equivalente na escala do LinkedIn (`None` / `Conversational` / `Professional` / `Native or bilingual`), que não tem "básico". A mesma escala na interface em português (Nenhuma / Conversação / Proficiente / Nativo ou bilíngue) é reconhecida.

### `compensation`
Pretensão CLT (faixa e valor único quando o formulário pede um número só), PJ no Brasil (mínimo) e PJ nos EUA (USD/mês), salário e benefícios atuais (em texto pt/en prontos para os campos).

### `availability`, `diversity`, `consents`, `referrals`, `documents`, `free_text`
Regimes aceitos e aviso prévio; diversidade ("prefiro não responder"); LGPD, triagem por IA e declaração de veracidade; "conhece alguém na empresa?" (padrão Não) e texto "NA" para campos "se sim…" que não se aplicam; currículo por idioma da vaga (PT/EN, bilíngue = EN), carta de apresentação, seguir empresa; pitch curto.

### `learned[]` — respostas para perguntas específicas
Para uma pergunta que nenhuma regra resolve (o `apply_prepare` a lista em `answers_preview.form.unanswered`), você pode dar a resposta uma vez:

```json
"learned": [
  { "label_norm": "voce possui experiencia profissional utilizando python para desenvolvimento de solucoes de dados, automacoes ou projetos de inteligencia artificial", "kind": "radio", "answer": "Yes" }
]
```

- `label_norm`: copie o valor que a prévia mostra (rótulo sem acentos, minúsculo, sem `*`/`?` no fim). Só vale para essa pergunta exata.
- `kind`: o tipo do campo da prévia (`radio`, `select`, `text`…); omitido = qualquer tipo.
- `answer`: o texto da opção (`"Yes"`, `"Sim"`), `true`/`false` (sim/não ou checkbox), um número, ou o texto para campos abertos.
- O Claude só acrescenta uma entrada com a **sua aprovação explícita**. Perguntas de salário, benefícios, diversidade ou CPF respondidas aqui continuam sensíveis (exigem `confirm_sensitive` e aparecem mascaradas).

## Como o preenchimento vai funcionar (desenho para `apply_execute`)

Para cada campo do formulário, na ordem, o primeiro que resolver vence:

1. **Chave semântica do LinkedIn** (`FIRST_NAME`, `LAST_NAME`, `PHONE_MOBILE`) → `profile`.
2. **Alias aprovado** (`learned[]`: rótulo normalizado igual a um já aprovado).
3. **Famílias de regex** pt/en: "Há quantos anos… X", "How many years… X", "Você tem conhecimento de X", nível de inglês/espanhol, salário desejado/atual, CPF, LGPD, IA, veracidade, realocação, autorização de trabalho, "conhece alguém", etc.
4. **Impressão digital das opções** (ex.: um select com Feminino/Masculino/Prefiro não responder).
5. **Nada resolveu** → campo obrigatório: **para e pergunta a você**; opcional: deixa e avisa.

Regras: nunca usar LLM/fuzzy para preencher (só sugerir); se duas regras baterem, para; sim/não pelo prefixo da opção (Sim/Yes vs Não/No); "nenhum" nunca combinado com outras opções em múltipla escolha; currículo escolhido pelo `aria-label` com o nome do arquivo.

## Editar com segurança

- Edite com qualquer editor; mantenha JSON válido.
- `null` = "ainda não respondido" → o formulário para nesse campo.
- Depois de editar, peça ao Claude um `jobs_list_local { target_only: true }` para conferir o efeito dos filtros.
