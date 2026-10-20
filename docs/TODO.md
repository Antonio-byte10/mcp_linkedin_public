# Pendências e Backlog (TODO)

Este documento lista o que ainda está em aberto no `mcp_linkedin_public`. O que já foi entregue, versão por versão, está no [CHANGELOG](CHANGELOG.md).

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
