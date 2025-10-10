# Slack → Jira Poller

Sincroniza alertas do Slack para issues no Jira com título, descrição estruturada (ADF) e imagens inline.

## Requisitos
- Node.js LTS
- Jira Cloud (e-mail + token de API)
- Slack bot com acesso ao canal

## Configuração
1) Crie um arquivo `.env` (veja `.env.example`):
```
SLACK_TOKEN=xoxb-...
SLACK_CHANNEL_ID=XXXXXXXXX
JIRA_BASE=https://sua-org.atlassian.net
JIRA_EMAIL=voce@empresa.com
JIRA_API_TOKEN=xxxxxxxx
JIRA_PROJECT_KEY=TDS
JIRA_ISSUE_TYPE=Incident
JIRA_PRIORITY_ID=10002
JIRA_ASSUNTO_ID=19745
JIRA_ASSUNTO_DEFAULT=Plantão - API / Transportadoras
POLL_INTERVAL_MS=15000
```

2) Instale dependências:
```
npm install
```

3) Execute:
```
npm start
```

## Endpoints
- `/meta`: prioridades permitidas e opções de Assuntos relacionados TDS
- `/debug/last`: último evento bruto do Slack processado

## Notas
- Prioridade e Assunto são enviados por ID (com fallback por nome).
- Descrição usa ADF com links clicáveis e imagens inline.
- Campo `labels` não é enviado (depende de tela no Jira).
