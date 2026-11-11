# Segurança e dados de cada instalação

Não inclua credenciais, cookies, capturas de telas privadas ou chamados reais em uma issue pública. Se encontrar uma vulnerabilidade, use o canal privado de segurança do repositório quando estiver disponível; compartilhe apenas a reprodução mínima com dados fictícios.

As integrações são configuradas pelo administrador de cada implantação. Segredos ficam no ambiente privado ou em cofre cifrado no servidor. Dados de operação, rascunhos, backups e sessões são gerados na implantação e ficam fora do conteúdo versionado.

O modo padrão usa loopback e um processo Node. Hospedagem compartilhada exige autenticação e autorização próprias, HTTPS, armazenamento persistente e política de retenção apropriada. A conexão OAuth de cada navegador isola as consultas Jira; ela não implementa autorização individual de acesso a todos os registros de passagem.

Falhas de gravação de tokens fazem a integração Jira parar com erro, sem salvar em texto puro. Um marcador de bloqueio pode impedir restaurar um snapshot antigo. Corrija a causa no armazenamento e invalide as sessões afetadas antes de reconectar.

Se um segredo da sua implantação for exposto, revogue-o no provedor, substitua-o no servidor e remova-o de todo o histórico público. Apagar apenas o arquivo atual não elimina versões anteriores. Uma instalação deve manter seus próprios procedimentos de backup, resposta a incidentes e aprovação de aplicativos externos.
