# Contribuir

Use Node.js 24+, clone o projeto e execute `npm test` e `npm run check:syntax`. A aplicação não depende de serviços reais para desenvolver o formulário e os rascunhos.

Mantenha fixtures fictícias e configure o site/projeto Jira em cada instalação. Não fixe domínio de cliente, números reais de chamados, nomes de pessoas, filtros privados, objetos de inventário, tokens ou webhooks no código.

O frontend pode receber somente a lista pública de configuração de `app-config.js`. Não acrescente JQL, credenciais ou tokens nessa lista. Mudanças na autenticação precisam de testes de isolamento entre navegadores, estado OAuth, renovação e falha de armazenamento.

Para testar integração real, use sua própria implantação privada e seus próprios serviços. Não envie seu `.env`, diretório de dados, backups ou cofres em uma contribuição. Screenshots e issues devem usar exemplos fictícios e ocultar informações pessoais.

Descreva o problema, a mudança de comportamento e como a validou. Inclua teste quando houver mudança de dados, validação ou integração; para ajustes visuais, confira desktop, tela estreita e listas com centenas de chamados.
