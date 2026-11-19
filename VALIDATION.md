# Evidências de execução — 18/11/2026 (America/Sao_Paulo)

## Ambiente final

- Windows local, projeto físico em D: com vínculo pela pasta de entregáveis do chat.
- Bun 1.4.4; TypeScript 5.9.3; NestJS 11.2.11; MikroORM 6.6.18.
- Docker Engine 28.5.1, PostgreSQL `17-alpine` e LocalStack **4.0.3**, ambos em containers reais.
- PostgreSQL do Compose: 127.0.0.1:55433. LocalStack: 127.0.0.1:4566.
- API construída pelo Dockerfile e executada em **três containers**, com workers ativos.
- Enunciado completo fornecido pelo usuário foi lido antes desta implementação.

## Resultado da suíte completa

Comando: `scripts\run.ps1 check:all`, com TEST_DATABASE_URL no PostgreSQL do Compose.

| Etapa | Resultado |
|---|---|
| TypeScript strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes | Sem erros |
| Unidade | 32 testes, 81 asserções, zero falhas |
| PostgreSQL/HTTP/migrations | 20 testes, 174 asserções, zero falhas |
| SQS/LocalStack/recuperação | 8 testes, 39 asserções, zero falhas |
| Total | **60 testes, 294 asserções, zero falhas** |

Esses totais incluem 25 testes do baseline preservado e 35 testes adicionados
para o enunciado completo. PostgreSQL e SQS não foram substituídos por mocks.
Há hooks de falha explícitos em pontos específicos, mantendo persistência e
transporte reais.

## Matriz dos cenários obrigatórios

| Cenário | Evidência |
|---|---|
| Dinheiro, Wallet, operações e estados | `tests/unit/processor.test.ts` |
| 50 apostas iguais em paralelo | Uma aplicação, 49 replays, único débito; três PIDs HTTP |
| Duas apostas de 80 / saldo 100 | Um PROCESSED, um REJECTED persistido, saldo 20 |
| Wallets distintas | Operações paralelas e reconciliação final |
| Idempotência divergente | HTTP 409 sem replay nem efeito adicional |
| REFUND antes de BET | PENDING_REFERENCE → PROCESSED com worker SQL concorrente |
| Referência expirada | REJECTED / REFERENCE_EXPIRED |
| Reversão de crédito já gasto | REJECTED / REVERSAL_INSUFFICIENT_FUNDS |
| Wallet/ledger/Inbox/Outbox atômicos | Falha injetada imediatamente antes do commit; todas as gravações revertidas |
| Imutabilidade e consistência no schema | SQL direto rejeitado por triggers/constraints |
| Migrations reversíveis | up/down/up em schema isolado, com ROLLBACK final |
| Inbox/redelivery SQS | Mensagens repetidas reais, um efeito financeiro |
| Crash depois do commit, antes do ack | Processo encerra com código 86; outro consome redelivery sem novo débito |
| Dois publishers concorrentes | Eventos reivindicados sem sobreposição e publicados |
| Crash depois do envio, antes da marcação | Processo encerra com código 87; lease expira e outro publisher retoma |
| Payload inválido | Mensagem observada na DLQ real |
| Infraestrutura transitória | Pool PostgreSQL fechado causa retry; recuperação aplica uma vez |
| Cinco recebimentos com falha | FAILED persistido, failureCode e encaminhamento para DLQ |
| SQS indisponível | Outbox permanece pendente com backoff; publicação após recuperação |

Todos os cenários financeiros verificam saldo reconstruído pelo ledger.
No teste de crash, a visibilidade/lease é antecipada explicitamente depois da
morte para evitar esperas de 30/60 segundos. A reentrega e o novo processo são reais.

## Compose e demonstração integrada

`docker compose --profile app up -d --build --wait` concluiu. Health live e ready
retornaram sucesso nas três réplicas; ready confirmou PostgreSQL e SQS.

`scripts/demo.ts` criou wallet de 100 pela API, enviou BET 80 pelo SQS e aguardou
o consumidor de uma das réplicas. Depois repetiu a operação por HTTP: replay=true,
saldo 20. Reconciliação: armazenado 20, calculado 20, diferença 0, duas entradas.
O resultado está em [demo-result.json](demo-result.json).

As três réplicas foram reiniciadas por `docker compose restart api` para verificar
que a API usa estado persistente. Após o reinício, a mesma wallet continuou com
saldo 20.00, diferença zero, duas entradas e `consistent: true`. Readiness retornou
sucesso e `/metrics` respondeu HTTP 200. Os processos de teste também são encerrados;
as filas/volumes de avaliação não são apagados como limpeza.

## Intervenções locais preservadas

O C: havia ficado sem espaço; o usuário liberou espaço. Docker Desktop apresentava
erro de sockets inacessíveis. Foi parado e suas pastas contendo sockets foram
renomeadas para backup, sem reset de fábrica, exclusão de imagens ou volumes:

- `%LOCALAPPDATA%\Docker\run.before-jungle-20261118`
- `%LOCALAPPDATA%\Docker\run.before-jungle-20261118-2`
- `%LOCALAPPDATA%\docker-secrets-engine.before-jungle-20261118`

Após recriação dos diretórios de comunicação, Docker iniciou. O banco portátil
anterior e os dados do baseline foram preservados. `.env.portable-backup` conserva
a configuração anterior; `.env` passou a apontar para o PostgreSQL do Compose.

## Limites das evidências

- Workflow de CI foi atualizado, mas não executado remotamente; nenhum repositório foi publicado.
- Nenhum benchmark de throughput/p95, teste de falha física de disco ou desastre regional.
- LocalStack não representa todas as condições operacionais de AWS. O container do
  emulador não tem persistência configurada; reiniciar/substituir esse container
  pode perder suas filas. Os testes de recuperação reiniciam os **processos da
  aplicação**, preservando o broker. PostgreSQL usa volume persistente.
- Não houve teste de produção com dinheiro real ou revisão externa de segurança.
- Autenticação real e diferenciais opcionais não fazem parte da entrega.

Os testes constituem evidência dos cenários descritos, não uma prova de ausência
de qualquer defeito possível.
