# Decisões de arquitetura

## Limite da especificação recuperada

A conversa anterior confirmou NestJS/Bun, PostgreSQL/MikroORM, decimal.js,
MoneyProps, construtor privado, HTTP + SQS e a dispensa de autenticação com
documentação e guard. O enunciado completo e o projeto da outra máquina não
estavam acessíveis. Contratos HTTP, escala de dinheiro, moedas e semântica de
liquidação abaixo são decisões explícitas deste MVP, a confrontar com o original.

## Caminho de uma operação

```mermaid
sequenceDiagram
  participant C as Cliente
  participant H as Controller NestJS
  participant S as WageringService
  participant DB as PostgreSQL
  C->>H: POST + Idempotency-Key
  H->>S: walletId, chave, corpo
  S->>S: Validar contrato e Money
  S->>DB: BEGIN + SELECT carteira FOR UPDATE
  S->>DB: Buscar chave persistida
  alt Chave já existe
    S->>S: Comparar fingerprint
    S-->>C: Resposta original ou conflito
  else Intenção nova
    S->>S: Aplicar Wallet / Wager
    S->>DB: Gravar aposta, operação e ledger; flush saldo
    S->>DB: COMMIT
    S-->>C: Resultado confirmado
  end
```

Retornar dentro de `em.transactional` ainda aguarda a conclusão da transação.
Qualquer exceção desfaz todas as gravações desse callback. `em.execute` utiliza
o contexto transacional do EntityManager; não se usa uma conexão avulsa para o ledger.

## Dinheiro e domínio

[Money](src/domain/money.ts) recebe strings decimais não negativas: até 16 dígitos
inteiros e 2 casas, sem notação científica, espaços ou zeros iniciais ambíguos.
Normaliza para duas casas. BRL/USD/EUR são as moedas deste MVP; não há câmbio.
Decimal usa configuração isolada com 40 dígitos de precisão. Soma e subtração
voltam pela validação: overflow e saldo negativo são rejeitados, nunca arredondados
silenciosamente. PostgreSQL armazena `numeric(18,2)`, retornado como string.

`private constructor` força a fábrica no TypeScript; não é barreira de segurança
contra JavaScript hostil. A proteção real da entrada também vem das validações
em runtime, das regras de domínio e das constraints. `Wallet` encapsula saldo;
[Wager](src/domain/wager.ts) protege propriedade e transições PLACED → SETTLED ou
CANCELLED. Não existe transição de volta. Correções financeiras exigiriam uma
operação compensatória futura, nunca edição do histórico.

## Persistência e locking

[WalletSchema](src/database/wallet.entity.ts) mapeia a entidade persistida com
MikroORM. O serviço usa ORM para ler/travar a carteira e persistir seu saldo;
SQL parametrizado explícito para tabelas de operações, apostas e ledger. Isso
mantém ordem e contexto das gravações visíveis. Não há entidades ORM completas
para essas três tabelas; a migration é a fonte do schema. Não executar schema
update automático, que desconhece as tabelas e os triggers adicionais.

Cada chamada recebe um EntityManager novo. Com isolamento padrão READ COMMITTED,
`SELECT ... FOR UPDATE` serializa escritores da **mesma carteira**, inclusive
em processos diferentes. Carteiras diferentes não compartilham esse lock.
Todas as operações sobre apostas passam primeiro pela carteira proprietária.
Não há transferências entre carteiras; adicioná-las exigiria ordenar os dois locks.

O lock é adquirido antes de ler a chave idempotente e antes de decidir sobre saldo.
Timeout de lock: 5 s; statement: 10 s nas operações. Conflitos transitórios
identificados retornam 503. Não existe retry infinito automático. Não se mantém
transação aberta durante chamada de rede externa. A reconciliação também bloqueia
a carteira para evitar comparar snapshots incompatíveis; não é um job em lote.

## Idempotência

Chave com 1–128 caracteres, escopo `(wallet_id, key)`. SHA-256 de uma tupla estável
inclui tipo, aposta, valor normalizado e moeda. `10` e `10.00` representam a mesma
intenção. Mesma chave e intenção retornam a resposta JSON persistida; payload
diferente retorna 409. Resposta, saldo e ledger são confirmados juntos.

Se a resposta HTTP se perder depois do commit, repetir não reaplica a operação.
Se ocorrer rollback antes do commit, a chave não é gravada e o retry pode executar.
**Falhas de negócio não são memorizadas**: saldo insuficiente pode tornar-se sucesso
após depósito. Esta é uma escolha explícita, não idempotência de todos os erros.
Não há expiração ou limpeza das chaves. Wager ID também é único globalmente e
impede reapostar sob chave diferente. Clientes devem usar UUIDs canônicos.

## Ledger e integridade

Um lançamento assinado por operação: depósito positivo, aposta negativa,
cancelamento positivo e liquidação não negativa. Liquidação com zero deixa
rastro mesmo sem alterar saldo. Não é contabilidade de partidas dobradas:
não há conta da casa/contrapartida neste MVP.

A [migration](src/database/migrations/Migration202611180001.ts) estabelece PKs,
FKs compostas, unicidade da operação, moeda coerente com a carteira, não
negatividade, rejeição de NaN e um único lançamento de abertura/fechamento por
aposta. Triggers rejeitam UPDATE, DELETE e TRUNCATE em ledger e operações.
O histórico é ordenado por identidade `bigint`, não pelo relógio; lacunas por
rollback são normais. Triggers não impedem um administrador de desabilitá-los.

As constraints não garantem sozinhas `wallet.balance = sum(ledger.delta)` para
qualquer SQL arbitrário. O serviço garante a atualização conjunta, e a
reconciliação verifica soma e cada saldo acumulado. SQL privilegiado pode
introduzir inconsistência; a reconciliação sinaliza, não corrige silenciosamente.
O banco local usa proprietário para facilitar avaliação. Em produção seriam
necessários papéis distintos para migrations e aplicação, privilégios mínimos
e proteção de credenciais. Uma migration down destrutiva foi recusada por design.

## Autenticação deliberadamente ausente

[EvaluationAuthGuard](src/http/evaluation-auth.guard.ts) implementa `AuthorizationPort`
e retorna `true` explicitamente. Nenhum JWT, senha ou validação de identidade foi
implementado, seguindo a opção solicitada. O guard não simula segurança.
Conferir wallet_id da aposta protege integridade, não autentica o chamador.
Qualquer cliente local pode operar qualquer carteira. API e banco vinculam-se a
loopback; não implantar esta configuração para uso público ou dinheiro real.

## Mensageria: lacuna, não entrega concluída

SQS/LocalStack, consumidor, Inbox, Outbox, DLQ e retry de mensagens não foram
implementados nem testados. O núcleo suporta concorrência no banco e replay
HTTP, mas isso não satisfaz sozinho um sistema distribuído por filas.

Próxima etapa proposta: evento com ID estável; Inbox com unicidade por produtor/ID
e hash do payload; efeito financeiro + Inbox + Outbox na mesma transação; worker
reivindicando lotes com `FOR UPDATE SKIP LOCKED`; envio fora da transação;
marcação posterior. Falha entre envio e marcação gera reenvio: consumidor deve
deduplicar. SQS só receberia DeleteMessage após commit. Planejar timeout de
visibilidade, backoff, DLQ e mensagens fora de ordem antes de implementar.

Também ficaram fora: métricas/tracing, readiness, rate limits, paginação de ledger,
job de reconciliação global, testes de queda de processo e carga prolongada,
contabilidade dupla, reservas parciais, chargebacks e exportação auditável.

Referências técnicas: [transações MikroORM](https://mikro-orm.io/docs/transactions),
[migrations](https://mikro-orm.io/docs/migrations) e
[instalação Bun](https://bun.sh/docs/installation). O projeto fixa MikroORM 6.6.18;
documentação de versões posteriores pode ter APIs diferentes.
