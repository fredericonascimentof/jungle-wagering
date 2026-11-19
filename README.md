# Jungle Gaming — Distributed Wagering Processor

## Visão geral

Implementação de um processador distribuído de transações de apostas, desenvolvido em TypeScript com NestJS e Bun.

O sistema utiliza PostgreSQL para persistência transacional, MikroORM para gerenciamento de dados e AWS SQS para processamento assíncrono de mensagens.

### Tecnologias

- TypeScript em modo estrito
- Bun 1.x
- NestJS
- PostgreSQL
- MikroORM
- AWS SQS / LocalStack
- Docker e Docker Compose
- decimal.js para operações monetárias

### Características principais

- Processamento de apostas, ganhos, perdas e reversões
- Controle de saldo e histórico financeiro
- Idempotência de operações
- Controle de concorrência por carteira
- Persistência transacional
- Padrões Inbox e Outbox
- Processamento distribuído com múltiplas instâncias
- Reconciliação de saldos
- Testes unitários, de integração e de mensageria

## Executando o projeto

### Pré-requisitos

- Docker Desktop
- Docker Compose
- PowerShell
- Bun 1.x para instalação direta

### Preparação

Na raiz do projeto, execute:

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d --wait postgres localstack
bun run db:migrate
```

### Executando os testes

```powershell
bun run check:all
```

### Iniciando a aplicação

```powershell
bun run start
```

A API estará disponível em `http://127.0.0.1:3000`, conforme a configuração do ambiente.

Para consultar os detalhes de arquitetura, decisões técnicas e validação, consulte `ARCHITECTURE.md` e `VALIDATION.md`.