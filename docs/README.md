# Documentação — mcp_linkedin_public

MCP (Model Context Protocol) em TypeScript que opera **a sua própria conta do LinkedIn** num perfil dedicado do Microsoft Edge (padrão) ou do Google Chrome, via Playwright. Serve para três frentes:

1. **Vagas** — buscar, filtrar o que você ainda não se candidatou, enriquecer detalhes, gerar planilhas de análise com nível de match, e candidatura simplificada em lote aprovada por você.
2. **Pessoas** — encontrar recrutadores, heads e pessoas-chave da área.
3. **Prospecção B2B** — achar empresas de um nicho/porte/região e enriquecer os dados delas.

## Índice

| Documento | Para quê |
|---|---|
| [INSTALL.md](INSTALL.md) | Build, instalação no Claude Desktop e no Claude Code, primeiro login, solução de problemas |
| [WORKFLOWS.md](WORKFLOWS.md) | Como usar no dia a dia, com exemplos de pedidos ao Claude |
| [TOOLS.md](TOOLS.md) | Referência de todas as 35 ferramentas (parâmetros, retorno, limites) |
| [ANALYSIS.md](ANALYSIS.md) | Planilha de vagas: colunas, abas, regras de match (Alto/Médio/Baixo/Pendente), senioridade, área, skills |
| [ANSWER_BANK.md](ANSWER_BANK.md) | `<dados>/answers.json`: o que é cada seção, como editar, política de preenchimento |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Como o código está organizado, fluxo de uma chamada, banco SQLite, sessão do navegador |
| [SAFETY.md](SAFETY.md) | Política de ações, proteções da conta, segurança, privacidade (LGPD) |
| [MAPPING.md](MAPPING.md) | Mapa técnico do DOM do LinkedIn (reconhecimento do DOM de 2026) |
| [TODO.md](TODO.md) | Próximos passos e ideias |
| [CHANGELOG.md](CHANGELOG.md) | Histórico do que foi construído e corrigido |
| [answers.template.json](answers.template.json) | Modelo vazio do banco de respostas |

## Em uma frase cada

- **Leitura é automática**; **escrita** (candidatar, conectar, mensagem) só acontece em itens que **você escolheu** de uma lista, dentro de cotas.
- Tudo fica **local** no seu PC, na pasta de dados `<dados>` = `%LOCALAPPDATA%\mcp-linkedin` (fora da pasta do código): `linkedin.db` (cache), `answers.json` (suas respostas), `exports/` (planilhas), os perfis do navegador.
- O navegador do MCP (Edge por padrão; Chrome com `LINKEDIN_BROWSER=chrome`) é **separado** do seu navegador normal, abre sozinho quando precisa e **fecha após 3 min** sem uso.

## Estado atual (0.9.0; validado ao vivo pelo autor)

| Área | Estado |
|---|---|
| Sessão, cotas, trava de segurança, modo headless | pronto, testado ao vivo (Edge 100% em background) |
| Busca/detalhe/enriquecimento de vagas, rastreador de candidaturas | pronto, testado ao vivo |
| Planilha de análise com match | pronto, testado ao vivo (aba única consolidada "Vagas") |
| Pessoas e empresas (busca, perfil, sobre, exportação) | pronto, testado ao vivo |
| Mapeamento de formulários Easy Apply (só leitura) | pronto (os testes de formulário rodam sobre os seus mapas em `<dados>/form-maps/` e são pulados sem eles) |
| Candidatura em lote real (`apply_execute`) | pronto, testado ao vivo |
| Prévia das respostas no `apply_prepare` (`answers_preview`) | pronto (local, a partir dos formulários mapeados) |
| Conexão em lote real (`connect_execute`) | pronto, testado ao vivo (com e sem nota) |
| Decisores (`leads_find_decision_makers`) | pronto, testado ao vivo |
| Mensagens a contatos de 1º grau (`message_prepare` / `message_execute`) | pronto: `dry_run` e envios reais conferidos na conversa; `dry_run` continua o padrão |
| Buscas salvas (`jobs_watch_*`) | pronto, testado ao vivo |
| Notas de convite por modelo (`note_template`) | pronto, testado ao vivo |
| Chrome como alternativa ao Edge | abre e navega ao vivo; falta login/sessão completa |
| Limpeza LGPD (`data_purge`) e `pipeline_stats` | pronto (locais, sem navegador) |
| Limpeza LGPD automática (`LINKEDIN_AUTO_PURGE_DAYS`, opt-in, ao iniciar) | pronto desde 0.8.1 (desligada por padrão; coberta por testes locais) |
| CI no GitHub Actions (`.github/workflows/ci.yml`) | typecheck, testes e build a cada push na `main` e a cada pull request (desde 0.8.1) |
| Preenchimento de perguntas via `<dados>/answers.json` | pronto (resolver + formfill); typeahead/upload lidos pelo mapeador, ainda não preenchidos numa candidatura real |
