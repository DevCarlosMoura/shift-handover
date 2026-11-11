# Shift Handover

Aplicação de passagem de turno com formulário, rascunhos, histórico, importação do Jira Cloud e envio opcional ao Google Chat. Interface em português, tema escuro e listas compactas com busca para centenas de chamados.

Esta distribuição começa vazia. Não contém contas, chamados, filtros privados, credenciais, sessões, histórico, backups ou identidade visual de uma organização. Cada instalação configura seus próprios serviços.

## Executar sem integrações

Requisito: **Node.js 24 ou superior**. Não há dependências npm externas.

```sh
git clone https://github.com/DevCarlosMoura/shift-handover.git
cd shift-handover
npm start
```

Abra **http://127.0.0.1:4173**. Sem credenciais, o formulário, a prévia e os rascunhos funcionam localmente; o Jira fica desativado e nenhuma mensagem é enviada ao Chat.

Para personalizar, copie `.env.example` para `.env`, retire o `#` das opções desejadas e ajuste os valores. No PowerShell use `Copy-Item .env.example .env`; em Linux/macOS use `cp .env.example .env`. O arquivo `.env` é carregado pelo Node e não entra no Git. Opções não ativadas no exemplo não sobrescrevem o configurador Windows.

```dotenv
APP_NAME="Shift Handover"
TEAM_NAME="Minha equipe"
JIRA_PROJECT_KEY=OPS
```

Cada instalação atende **um projeto Jira**. Mudar `JIRA_PROJECT_KEY` altera o prefixo aceito na interface, na importação e no backend. Nome da aplicação, equipe, site e filtro não são fixos no código.

## Conectar seu Jira Cloud

O administrador da implantação configura **um aplicativo OAuth 2.0 (3LO)** para ela. Os usuários autorizam suas próprias contas nesse aplicativo; não compartilham Client Secret, API tokens nem cookies.

1. No [console de desenvolvedor da Atlassian](https://developer.atlassian.com/console/myapps/), registre a integração da sua implantação.
2. Adicione a API Jira com os escopos clássicos de leitura `read:jira-work` e `read:jira-user`.
3. Cadastre o callback da aplicação. No endereço local padrão: `http://127.0.0.1:4173/auth/jira/callback`.
4. Configure `JIRA_SITE_URL`, `JIRA_PROJECT_KEY`, `JIRA_CLIENT_ID` e `JIRA_CLIENT_SECRET` no seu ambiente ou `.env` privado. O Client ID OAuth está em Settings; o App ID da visão geral é outro identificador.
5. Reinicie e use **Conectar Jira**. A autorização pede também `offline_access` para renovar a conexão. Depois use **Importar do Jira** na data da ficha.

No Windows, a alternativa ao `.env` é o configurador com entrada oculta e armazenamento protegido por DPAPI:

```sh
npm run configure -- --local
npm run configure -- --jira
npm start
```

As buscas retornam pendentes atuais atribuídos à conta conectada e chamados resolvidos por essa conta na data escolhida, conforme o fuso do perfil Jira. Usam campos padrão de resolução; workflows que não preenchem resolução precisam ser adaptados. A importação lê somente IDs/status, combina as listas manuais e salva um rascunho; não envia a passagem ao Chat.

O filtro base padrão é `project = "OPS"` para esse exemplo. Use `JIRA_BASE_JQL` para acrescentar condições próprias, **sem ORDER BY**, mantendo apenas o projeto configurado. Esse filtro fica no servidor e não é exposto na configuração pública.

Para outras pessoas autorizarem suas contas, habilite a distribuição apropriada da integração na Atlassian, preenchendo os dados reais de responsável, privacidade e suporte exigidos pela plataforma. Cadastrar um aplicativo privado não libera automaticamente o uso por outras contas. [Documentação oficial de OAuth](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/).

## Conectar seu Google Chat

Crie um incoming webhook no espaço de destino da sua implantação e configure `CHAT_WEBHOOK_URL` no ambiente privado do servidor. No Windows, também pode usar:

```sh
npm run configure -- --chat
```

Reinicie o servidor. **Salvar rascunho** nunca envia mensagens; **Enviar passagem** publica o conteúdo completo. Não coloque o webhook no frontend, em imagens, issues ou commits. O envio usa HTTPS e timeout; entregas incertas ficam identificadas para evitar duplicação.

## Configuração

| Variável | Padrão / finalidade |
| --- | --- |
| `APP_NAME`, `TEAM_NAME` | Nome neutro e identificação da sua equipe. |
| `HOST`, `PORT` | `127.0.0.1`, `4173`; acesso local por padrão. |
| `APP_ORIGIN` | Origem do navegador; HTTPS no servidor compartilhado. |
| `JIRA_SITE_URL` | Origem HTTPS do seu Jira Cloud, sem caminhos ou parâmetros. Vazia desativa OAuth. |
| `JIRA_PROJECT_KEY` | `OPS`; uma chave de projeto por instalação. |
| `JIRA_BASE_JQL`, `JIRA_FILTER_LABEL` | Filtro privado opcional e nome público legível. |
| `JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET` | Credenciais OAuth somente no servidor. |
| `JIRA_REDIRECT_URI` | Callback explícito, ou derivado de `APP_ORIGIN`/porta local. Deve coincidir com o cadastrado na Atlassian. |
| `JIRA_SESSION_DAYS` | 30 dias de inatividade; aceita 1–90. Revogação/expiração na Atlassian continuam valendo. |
| `JIRA_SESSION_KEY` | Fora do Windows, chave base64 de 32 bytes para AES-256-GCM, fornecida pelo seu gerenciador de segredos. |
| `CHAT_WEBHOOK_URL` | Vazia mantém o envio em modo prévia. |
| `HANDOFF_DATA_DIR` | Diretório absoluto persistente; padrão `data` nesta instalação, fora de `public`. |
| `HANDOVER_CONFIG_DIR` | Diretório absoluto para configurações e cofre. Use outro para cada instalação independente. |

Prioridade: **ambiente do processo > `.env` > configurações/cofre local > padrões**. No Windows, o cofre padrão fica em `%LOCALAPPDATA%\ShiftHandover`; nos demais sistemas, em `~/.config/shift-handover`. Uma instalação nova não procura configurações de outros aplicativos.

Não há autenticação corporativa nem autorização por dono de registro neste protótipo. Antes de expor uma instalação compartilhada, configure HTTPS e autenticação/controle de acesso no seu proxy ou implemente esses controles. O histórico JSON atende um único processo; múltiplas instâncias exigem banco e armazenamento de sessões compartilhados. Jira Data Center não é suportado por este fluxo OAuth Cloud. GitHub Pages hospeda arquivos estáticos e não executa este backend Node.

## Dados, sessões e rascunhos

- Histórico: `data/handoffs.json` ou o diretório configurado, com gravação atômica e controle de revisão.
- Credenciais Windows: `secrets.dpapi`, cifrado para a conta do processo, fora dos arquivos públicos.
- Sessões Jira: arquivo separado cifrado; DPAPI no Windows ou AES-256-GCM com sua chave em outro sistema. Cookies são HttpOnly; tokens nunca vão para o JavaScript do navegador.
- O navegador lembra somente o ID e o horário do último rascunho salvo, separados por conexão. Reabrir recupera a ficha; alterações ainda não salvas geram aviso ao sair.
- A aplicação não coleta telemetria. Chamadas remotas das integrações acontecem com as configurações da sua implantação.

```sh
npm run check
npm run backup
```

`check` verifica configuração e armazenamento sem consultar Jira ou enviar mensagens. `backup` cria uma cópia privada do histórico em `data/backups`; essas cópias também não devem ser publicadas. Restaurar em outra conta/máquina pode exigir nova autorização das integrações.

## Desenvolvimento

```sh
npm test
npm run check:syntax
```

Os testes usam somente configurações e chamados fictícios, mocks de rede e armazenamento temporário. Não precisam de conta Atlassian nem webhook. Nunca use dados reais em testes, screenshots, fixtures ou relatórios públicos. Veja [CONTRIBUTING.md](CONTRIBUTING.md) e [SECURITY.md](SECURITY.md).

Distribuído sob a [licença MIT](LICENSE).
