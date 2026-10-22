# Pendências e Backlog (TODO)

Este documento lista o que ainda está em aberto no `mcp_linkedin_public`. O que já foi entregue, versão por versão, está no [CHANGELOG](CHANGELOG.md).

---

## Checklist de validação local (só na sua máquina)

O que falta validar depende da sua conta do LinkedIn, do seu navegador e das suas respostas, então só pode ser feito localmente, por você, escolhendo você mesmo as vagas. Nada disto roda no CI. Faça na ordem; cada passo diz o que deve acontecer.

**0. Base (5 min)**
- [ ] `npm install`, `npm run build`, `npm test`: deve terminar com `fail 0`. Reconecte o servidor no Claude (`/mcp` → linkedin → Reconnect).
- [ ] `session_status` e `quota_status` (só leitura): esperado `logged_in: true`, `checkpoint: false` e cotas cheias. Se vier `logged_in: false` (ou o erro `LOGGED_OUT`), faça login na janela do MCP; se vier `checkpoint: true`, `suspended: true` ou o erro `RATE_LIMITED`, pare e resolva no navegador antes de seguir.

**1. Seus dados**
- [ ] `answers_check` (ou `npm run setup-answers`): responda o que faltar. Preencha `free_text.pitch_short` e `why_company`, senão as perguntas abertas param a candidatura. O `answers.json` fica só na pasta de dados.
- [ ] Se a vaga tiver upload de currículo, coloque à mão o caminho em `documents.resume_paths.<idioma>` (o `answers_set` recusa caminhos de arquivo de propósito).

**2. Chrome (opcional)**
- [ ] Defina `LINKEDIN_BROWSER=chrome` no `env` do servidor e reconecte. `browser_launch`, faça login na janela do Chrome e confira `session_status`. Depois uma leitura curta (`jobs_search` com poucos resultados). Esperado: `browser: "chrome"`, `logged_in: true`, `checkpoint: false` e resultados normais.

**3. Candidatura com typeahead, dropdown ou upload**
- [ ] Escolha uma vaga Easy Apply que você realmente quer e rode `map_easy_apply_form` nela (só leitura). Confirme em `answers_preview` que cada pergunta tem origem no banco e que o que é sensível está marcado.
- [ ] `apply_prepare`, escolha o `job_id` e rode `apply_execute` com **uma vaga só**. Se pedir CPF ou salário, só use `confirm_sensitive: true` depois de revisar a prévia. Esperado: `success` só quando o LinkedIn confirmar; pergunta sem resposta volta como `needs_answer`, sem inventar.
- [ ] Rode `tracker_sync` e confira no próprio LinkedIn (Minhas vagas → Candidaturas) que o envio aparece.

**4. Candidatura `unverified`**
- [ ] Só se ocorrer: uma candidatura que ficou `unverified` deve virar `done` depois do `tracker_sync`. Se não ocorrer, deixe em aberto.

**Como registrar o resultado**
- Funcionou: marque a caixa em "Pendências" abaixo e anote no [CHANGELOG](CHANGELOG.md).
- Falhou: abra uma issue com o passo, a mensagem de erro e o arquivo de `<dados>/applications/<job_id>.json` **sem dados pessoais** (apague nome, e-mail, telefone e CPF antes).

---

## Pendências e Melhorias Futuras (Backlog)

### 1. Validar ao vivo
- [ ] Chrome (`LINKEDIN_BROWSER=chrome`): abre e navega; falta validar o login e uma sessão completa.
- [ ] Preenchimento ao vivo de typeahead (cidade), dropdown não nativo e upload de arquivo: o mapeador e a prévia já os leem, mas nenhuma vaga `ready` com eles foi enviada ainda. O upload só acontece com um caminho que você colocou à mão em `documents.resume_paths.<idioma>`; sem ele, o campo de arquivo obrigatório faz a vaga voltar em `needs_answer`, e o opcional fica em branco.
- [ ] Uma candidatura `unverified` confirmada pelo `tracker_sync` numa rodada real (o código e o teste existem; só acontece quando o LinkedIn não confirma um envio).

### 2. Funcionalidades
- [ ] Perguntas que ainda param a candidatura (a resposta é sempre uma decisão sua, via `learned[]`): "relevant full-time experience", opt-ins de SMS/newsletter, disponibilidade de viagem, "4 dias presencial + 1 remoto", escola/disciplina em lista fixa.

### 3. Dados do usuário (`<dados>/answers.json`)
- [ ] Os campos de texto livre (`free_text.pitch_short`, `why_company`) vêm vazios no modelo: enquanto não forem preenchidos, perguntas abertas ("tell us about yourself") param a candidatura.

### 4. Privacidade e Segurança (LGPD)
- Nada pendente: a limpeza manual (`data_purge`) continua e a automática é opt-in (`LINKEDIN_AUTO_PURGE_DAYS`).
