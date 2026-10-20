# Segurança, conta e privacidade

> Automatizar o LinkedIn vai contra os termos de uso dele e pode levar a restrição da conta. As proteções abaixo reduzem o risco, mas não o eliminam. O uso é por sua conta.

## Política de ações (decidida por você)

| Tipo | Regra |
|---|---|
| Leitura / extração / planilhas | 100% automática |
| Candidatar, conectar, mensagem | O MCP mostra uma lista → **você escolhe** → executa só esses, dentro das cotas (mensagem: `dry_run` por padrão) |
| Mapeamento de páginas/formulários | Nunca digita, nunca seleciona, nunca envia |

## Proteções da conta

- **Ritmo**: ≥ 4 s (+ até 2,5 s aleatório) entre carregamentos de página, em todas as ferramentas.
- **Orçamento diário de leituras** por tipo (busca 60, perfil 80, empresa 80, vaga 150, rastreador 30, formulário 40, página 40). Zera à meia-noite (São Paulo).
- **Cotas de escrita**: candidaturas 25/24 h, convites 15/24 h e 100/7 d, mensagens 20/24 h — com reserva atômica no SQLite.
- **Trava persistente**: checkpoint, tela de login, HTTP 429 ou 999 → todas as ferramentas param até `session_resume`, que só deve ser chamado depois que você resolveu no navegador do MCP.
- **Detecção de sessão**: sem o cookie `li_at` → `LOGGED_OUT` em vez de devolver resultados vazios.
- **Por chamada**: buscas de pessoas/empresas até 5 páginas; rastreador incremental.

## Mensagens a contatos (`message_prepare` / `message_execute`)

Validado na interface real de 2026: `dry_run` e envios reais conferidos na conversa.

- **Dry run por padrão**: `message_execute` só envia com `dry_run: false` explícito. No `dry_run` abre a conversa, confere destinatário e grau, fecha **sem digitar**, não gasta cota e deixa o lote utilizável.
- **Só 1º grau**: perfis do cache em 2º/3º grau são rejeitados no `message_prepare`; na execução a página precisa mostrar um contato de 1º grau, senão `not_connected` antes de qualquer clique.
- **Nunca InMail/Premium**: controle de mensagem com texto de InMail/Premium/créditos, ou navegação para `/premium` ou `/sales`, vira `inmail_refused`; nada é digitado.
- **Só o texto aprovado**: o texto fica no lote com o seu SHA-256; `message_execute` não recebe texto e recusa o lote se o hash não bater (sem queimar o lote). Rascunho já existente no compositor nunca é sobrescrito (`composer_has_draft`).
- **Sem repetição**: quem recebeu mensagem nos últimos 7 dias (pendente, feita, `unverified` ou falha depois de digitar) é rejeitado no prepare e de novo na execução. Falha antes de digitar não bloqueia.
- **Cota**: `LIMIT_MESSAGE_DAILY` (padrão 20/24 h) com reserva atômica, como nos outros envios.
- **Verificação**: `done` só quando a conversa mostra o texto como a sua última mensagem, ela é nova e a caixa de texto ficou vazia depois do Enviar (um envio que falhou deixa o texto lá, mesmo que uma mensagem antiga idêntica seja a última visível); senão `unverified` (conta na cota, nunca repete). Se um compositor com texto digitado não puder ser fechado, o lote para com `DISCARD_FAILED` e avisa para apagar o texto (não enviar).

## Garantias do mapeador de formulários

- Abre só pelo botão de candidatura simplificada dentro do `main` (nunca o "Candidatar-se" externo).
- Só age no diálogo identificado pelo cabeçalho "Candidate-se à… / Apply to…"; diálogo desconhecido → para (`unknown_dialog`).
- Só clica em botões com texto exato `Avançar`, `Avaliar`, `Next`, `Review`; para ao ver `Enviar candidatura`.
- Sempre fecha com **Descartar** no diálogo "Salvar esta candidatura?" (em `finally`) e confirma que nada ficou aberto; se falhar, devolve `DISCARD_FAILED`.
- Telefone mascarado no resultado; HTML só é salvo com `save_html: true`.

## Aprovação de escrita

- `apply_prepare` grava um lote no SQLite (uso único, 30 min); `apply_execute` rejeita IDs fora do lote, lote usado/expirado e falta de cota.
- As instruções do servidor dizem ao Claude: só chamar `*_execute` com IDs que **você** escolheu na conversa.
- Pendente (antes de ligar o envio): confirmação fora do modelo (MCP elicitation ou `permissions.ask`) — ver [TODO.md](TODO.md).

## Segurança técnica

| Risco | Mitigação |
|---|---|
| Outro processo assumir a sessão | Navegador (Edge ou Chrome) por pipe, sem porta TCP de depuração |
| Navegar para páginas maliciosas / arquivos locais | Só `https://www.linkedin.com`; `map_page` restrito a caminhos de leitura (sem `/safety/go`, `/redir`, logout); para se a navegação sair do LinkedIn |
| Escrita de arquivo fora de `<dados>/` | `job_id` só numérico |
| Prompt injection (texto de vagas/perfis mandando o Claude agir) | Instruções do servidor marcam texto do LinkedIn como dado; textos cortados, sem caracteres invisíveis, embrulhados em `{untrusted_text}`; escrita exige escolha sua |
| Dependências | `npm audit`: 0 vulnerabilidades (override de `uuid`) |

## Privacidade (LGPD)

- Tudo fica no seu PC; nada é enviado a terceiros além do próprio LinkedIn (e do texto que as ferramentas devolvem ao Claude).
- A pasta de dados (`%LOCALAPPDATA%\mcp-linkedin`) fica fora da pasta do código: nada pessoal vai junto ao copiar ou publicar o projeto. Mesmo assim, `data/`, `.edge-profile/`, `.chrome-profile/`, `*.db` e `*.xlsx` estão no `.gitignore` como rede de segurança.
- `<dados>/answers.json` tem dados sensíveis seus (CPF, salário): não compartilhe a pasta.
- Os mapas (`<dados>/form-maps/`, `<dados>/page-maps/`) e o que eles devolvem ao Claude mascaram o seu e-mail, telefone e nome em todo o texto, inclusive no passo de revisão do Easy Apply (com os valores do formulário e do `answers.json`). Só os HTML de `save_html` guardam a página inteira.
- Dados de terceiros (pessoas, empresas) ficam só no cache; apague `<dados>/linkedin.db*` quando não precisar mais, ou use `data_purge`.
- **`data_purge`** (`older_than_days`, `scope`, `dry_run`): apaga do cache local pessoas e empresas (e, se pedido, vagas) não vistas há N dias (`last_seen`, ou `first_seen`). `dry_run` é o padrão e só conta. Também apaga os lotes de `*_prepare` com mais de N dias (guardam nomes, prévias de nota e textos de mensagem; o resultado conta em `batches`); um lote ainda utilizável (TTL de 30 min) nunca é apagado. Nunca apaga o registro de ações, vagas aplicadas, com ação de candidatura ou em lote aberto, nem pessoas contatadas (convite ou mensagem) nos últimos 90 dias; linhas de idade desconhecida são mantidas. `<dados>/page-maps/` e `<dados>/form-maps/` não são tocados: apague-os à mão.
  - **Limpeza automática (opcional)**: com `LINKEDIN_AUTO_PURGE_DAYS=N` (1–3650) o servidor roda essa limpeza uma vez ao iniciar, só para pessoas, empresas e lotes antigos (nunca vagas), com as mesmas proteções acima, e registra no log uma linha com o que foi apagado. Vem desligada: sem a variável nada é apagado sozinho. Cuidado com valores pequenos: `1` apaga todo o cache de pessoas e empresas a cada inicialização; recomendado 30 ou mais. Uma falha na limpeza vai para o log e não impede o servidor de iniciar.

## Revisões feitas

Três revisões com agentes (código, segurança e revisão final). Todos os itens CRITICAL/HIGH foram corrigidos; o resumo está em [CHANGELOG.md](CHANGELOG.md).
