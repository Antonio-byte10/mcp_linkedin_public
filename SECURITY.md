# Política de segurança

## Reportar uma vulnerabilidade

Não abra uma issue pública para falhas de segurança. Use o **relato privado do GitHub**: aba *Security* → *Report a vulnerability* deste repositório. Descreva o que acontece, como reproduzir e o impacto; não inclua dados reais de ninguém (sessão, cookies, perfis, respostas pessoais).

## O que é considerado vulnerabilidade

- Uma ferramenta de escrita (`apply_execute`, `connect_execute`, `message_execute`) agir sem item aprovado num lote, ou fora das cotas.
- Texto vindo do LinkedIn (vaga, perfil, formulário) conseguir fazer o MCP executar uma ação, ler ou gravar fora da pasta de dados.
- Vazamento de dados pessoais (respostas, CPF, sessão do navegador) em logs, planilhas, mapas de formulário ou respostas das ferramentas.
- Navegação para fora de `https://www.linkedin.com`.

## O que fica fora

- Restrição de conta pelo LinkedIn: automatizar o LinkedIn pode violar os Termos de Uso da plataforma (veja o aviso no [README](README.md)). Esse risco é de quem usa.
- Problemas que dependem de acesso prévio à sua máquina ou à sua pasta de dados.

Mais sobre as travas e o modelo de ameaça em [docs/SAFETY.md](docs/SAFETY.md).

## Dados pessoais

O repositório nunca deve conter dados reais. A pasta de dados (banco, `answers.json`, perfis do navegador, planilhas) fica fora do código e está no `.gitignore`. Se você achar algum dado pessoal no histórico do repositório, avise pelo mesmo canal.
