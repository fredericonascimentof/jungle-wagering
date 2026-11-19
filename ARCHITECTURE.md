Arquitetura e decisões técnicas
1. Escopo e estrutura da implementação
A API em execução utiliza src/processor/http.ts. A implementação do domínio está em [`src/processor/domain.ts`](src/processor/domain.ts), sem dependência direta de NestJS ou do ORM. As fábricas constroem Money, Wallet, WagerTransaction e WalletLedgerEntry; o método rehydrate reconstrói estados persistidos, e as transições de negócio são representadas por métodos explícitos.

Os contratos de Inbox, Outbox e eventos estão em [`src/processor/events.ts`](src/processor/events.ts). Os adaptadores HTTP e SQS compartilham a operação [`ProcessorService.submit`](src/processor/service.ts), evitando duplicação da lógica financeira. A migração incremental adiciona as estruturas necessárias sem apagar ou reinterpretar registros existentes.

Os componentes anteriores conservados em src/domain, src/application, src/http/app.ts e docs/legacy não integram o caminho de execução da API atual.
2. Representação monetária e persistência
Os valores recebidos são strings decimais não negativas, com até 16 dígitos inteiros e duas casas decimais. Entradas com menor precisão são normalizadas para duas casas; valores com precisão superior não são arredondados silenciosamente.

Money utiliza uma instância isolada de Decimal, com precisão 40 e operações imutáveis. A representação respeita os limites de numeric(18,2) e valida conflitos de moeda. Valores negativos são admitidos apenas em resultados internos, como deltas e diferenças, nunca como valores financeiros submetidos. As moedas aceitas são BRL, USD e EUR, sem conversão cambial. O tipo number é usado para versões, contadores e tempos, não para valores monetários.

O MikroORM gerencia conexão, pool, migrações e transações com em.fork().transactional. O [schema de wallet](src/processor/wallet.schema.ts) mapeia campos numeric como strings. Dentro da transação, o serviço executa SQL parametrizado para tornar explícitas a ordem dos bloqueios e as gravações de Inbox, ledger e Outbox. Ao reconstruir os objetos, os valores numeric são convertidos para Money.

O schema é controlado por migrações, sem atualização automática (schema-update) em tempo de execução.
3. Protocolo transacional financeiro
O processamento de cada operação segue esta sequência:
1. Validar a entrada, normalizar Money e calcular o hash canônico dos campos de negócio.
2. Iniciar a transação. Para mensagens SQS, inserir ou bloquear o registro de Inbox identificado por (consumerName, messageId) e validar payloadHash. A Inbox não é confirmada isoladamente.
3. Bloquear a wallet de destino com SELECT ... FOR UPDATE.
4. Consultar a chave de idempotência e a identidade externa persistidas. Retornar o resultado salvo em caso de replay compatível; rejeitar conflitos. Restrições de unicidade no banco reforçam essa garantia.
5. Criar a WagerTransaction em PENDING, resolver eventual referência e aplicar as regras de domínio.
6. Persistir o resultado e o status; atualizar saldo e versão quando necessário; gravar ledger e eventos na Outbox.
7. Marcar a Inbox como processada e confirmar a transação (COMMIT). Somente depois responder à chamada HTTP ou confirmar a mensagem com DeleteMessage.
O nível de isolamento empregado é READ COMMITTED, combinado com bloqueio transacional por wallet. O processamento não depende de mutex em memória, bloqueio global ou ordenação FIFO para preservar a consistência financeira. Wallets distintas podem avançar em paralelo.

A versão de uma wallet começa em 1 e aumenta apenas quando seu saldo muda. O lançamento OPENING faz parte da criação, sem incremento adicional da versão inicial. A operação LOSS não gera movimentação no ledger e não altera a versão.

Não há transferências entre duas wallets. Caso sejam introduzidas, os bloqueios deverão seguir uma ordem determinística por identificador para reduzir o risco de deadlock. Conflitos transitórios conhecidos retornam HTTP 503. Os limites definidos para a entrada financeira são 5 segundos para aquisição do bloqueio e 10 segundos para execução da instrução.
4. Restrições e integridade no PostgreSQL
A [migração 002](src/database/migrations/Migration202611180002.ts) define:
- Unicidade para (player_id, currency), idempotency_key e (provider_id, external_transaction_id).
- Restrições de valores monetários finitos, escala decimal e não negatividade, com proibição explícita de NaN.
- Unicidade de lançamento do ledger por wallet e transação, e validação da relação before ± amount = after.
- Chaves estrangeiras relacionando wallet, moeda e transação, e restrição de uma reversão processada por referência e tipo.
- Triggers que impedem atualizar, excluir ou truncar o ledger, além de excluir transações financeiras.
- Imutabilidade de transações em estado terminal, incluindo resultado e campos de negócio.
- Constraint triggers diferidos que, no commit, verificam saldo igual à soma do ledger, integridade da sequência de lançamentos, versão equivalente a 1 + movimentos pós-abertura, existência do lançamento exigido para uma operação financeira PROCESSED e ausência de ledger para LOSS, pendências e rejeições.
Essas verificações permitem gravações intermediárias durante a transação, mas impedem a confirmação de um estado inconsistente. O teste de falha tardia exercita o rollback conjunto de wallet, transação, ledger, Inbox e Outbox.

Triggers podem ser desabilitadas por administradores com privilégios suficientes. Uma implantação de produção deve separar permissões de migração e aplicação, proteger segredos e definir backups. O uso de um usuário proprietário no ambiente Docker Compose é uma simplificação de avaliação.

As migrações incluem métodos up e down. O rollback administrativo pode ser destrutivo e não é executado automaticamente no início da aplicação. O cenário up/down/up é validado em schema isolado, com rollback final da transação de teste.
5. Operações financeiras e estados
As transições permitidas são:
PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PENDING_REFERENCE -> PENDING -> PROCESSED | REJECTED | FAILED | PENDING_REFERENCE
PROCESSED, REJECTED e FAILED são estados terminais. A retomada de referências pendentes é feita pelo método explícito resumeReference(), preservando as regras do domínio.
- BET: debita um valor positivo.
- WIN: credita um valor positivo e pode referenciar uma BET.
- LOSS: exige valor 0.00 e não gera ledger.
- REFUND: credita exatamente o valor da BET referenciada.
- ROLLBACK: inverte uma operação BET, WIN ou REFUND.
A operação referenciada precisa estar PROCESSED e corresponder a provedor, jogador, wallet, moeda e rodada. gameId é registrado e participa do hash, mas sua igualdade com a referência não é exigida pela interpretação adotada da seção 7.2 do enunciado.

Decisão de interpretação da seção 7.4: uma referência pode receber no máximo um REFUND e um ROLLBACK, mas não dois de cada tipo. Consequentemente, ambos os tipos podem apontar para a mesma BET. Se a regra esperada for uma única reversão integral, independentemente do tipo, a validação de domínio e o índice de unicidade precisarão ser alterados conjuntamente.

Uma reversão que debitaria crédito já consumido resulta em REJECTED / REVERSAL_INSUFFICIENT_FUNDS. Aposta sem saldo suficiente resulta em INSUFFICIENT_FUNDS. Referência inexistente ou ainda pendente leva a PENDING_REFERENCE; referência terminal não processada é rejeitada.

O worker de referências busca pendências cujo prazo de tentativa venceu, bloqueia a wallet e revalida status e prazo após obter o bloqueio. O backoff começa em 1 segundo e dobra até o teto de 300 segundos. São permitidos até 12 reprocessamentos ou 1 hora de idade. Ao esgotar o limite, a transação passa a REJECTED / REFERENCE_EXPIRED, com evento WagerTransactionRejected registrado atomicamente. Novas tentativas sem mudança observável de estado não criam eventos PendingReference redundantes.
6. Idempotência e contrato HTTP
O header Idempotency-Key é a fonte da chave de idempotência, sem fallback implícito. Sua unicidade é global; recomenda-se prefixá-la com o identificador do provedor. O identificador externo também é único por provedor. Reutilizar o mesmo identificador externo com outra chave constitui conflito.

O hash utiliza SHA-256 de JSON canônico: ordenação lexicográfica recursiva das chaves, omissão de campos ausentes, valores Money normalizados e UUIDs em minúsculas. Entram no hash somente os campos de negócio aceitos pelo contrato, não o header nem detalhes de transporte.

Uma requisição idêntica retorna o resultado persistido com idempotentReplay: true, incluindo o saldo registrado naquele resultado. Uma referência pendente pode evoluir até estado terminal, e o replay subsequente retorna o estado atualizado. Rejeições de negócio são persistidas e não são reexecutadas após um depósito posterior.

A API diferencia os códigos HTTP 400, 409, 422, 202 e 503. Payload malformado ou wallet inexistente antes da aceitação não gera transação financeira. Mensagens SQS estruturalmente inválidas são encaminhadas à DLQ.

No MVP, a identidade de provedor é um identificador validado e comparado nas regras de domínio; não há autenticação de provedor ou integração com um provedor de identidade.
7. SQS, Inbox e encerramento
O [consumidor SQS](src/processor/workers.ts) reutiliza ProcessorService.submit. A Inbox é persistida e compara payloadHash, detectando reutilização de messageId com conteúdo diferente.

Resultados terminais de negócio são confirmados na fila. PENDING_REFERENCE é aceito de modo durável e confirmado na fila, passando ao worker SQL para novas tentativas. Falhas transitórias não são confirmadas; a visibilidade da mensagem é ajustada com backoff. São admitidos até cinco recebimentos, e payloads inválidos são enviados diretamente à DLQ.

Quando se esgotam as tentativas de infraestrutura, o worker tenta persistir FAILED / INFRASTRUCTURE_RETRY_EXHAUSTED, sem movimento financeiro, e publicar WagerTransactionFailed antes do encaminhamento à DLQ. Se o PostgreSQL permanecer inacessível, não é possível registrar esse estado naquele momento; o mecanismo de redrive do SQS mantém a mensagem na DLQ para investigação.

A visibilidade inicial é de 30 segundos e é renovada a cada 10 segundos enquanto a mensagem está em processamento. Em SIGTERM ou SIGINT, a aplicação interrompe a entrada HTTP, para os loops, aguarda tarefas em andamento e fecha clientes. Em encerramento abrupto, a recuperação depende da expiração da visibilidade e do replay persistente. O Docker Compose concede até 45 segundos para encerramento controlado.
8. Outbox e entrega at-least-once
Os quatro eventos mínimos são subclasses concretas de IntegrationEvent, com versão 1, eventId estável, correlationId, causationId opcional, aggregateId e occurredAt em formato ISO. O payload transporta MoneyProps, não objetos Money.

O publisher reivindica até 10 eventos com FOR UPDATE SKIP LOCKED e persiste um lease de 60 segundos, identificado por token aleatório. A reivindicação é confirmada antes da chamada de rede; os envios ocorrem em paralelo, fora da transação. A confirmação ou novo agendamento de uma tentativa exige o mesmo token, impedindo que um worker antigo sobrescreva o estado de um lease mais recente.

Se houver falha antes do envio, o lease expira e permite a retomada. Se a falha ocorrer depois do envio, mas antes da marcação no banco, o evento pode ser reenviado com o mesmo eventId. A deduplicação FIFO utiliza esse identificador, mas a janela de deduplicação do broker não é uma garantia suficiente: consumidores externos devem deduplicar os eventos de forma persistente por eventId.

A garantia é de entrega at-least-once, não exactly-once. Eventos confirmados não são descartados por exceder um contador de tentativas; o atraso entre retries aumenta até 300 segundos.
9. Reconciliação, logs e métricas
A reconciliação bloqueia a mesma wallet e compara o saldo persistido com a soma e os saldos acumulados de cada lançamento, ordenados pela sequência bigint. O resultado informa diferença assinada, quantidade de lançamentos e indicador consistent. Divergências são registradas em log e contador; o sistema não corrige o saldo silenciosamente.

O ledger é de entrada única (single-entry). Partidas dobradas não fazem parte da implementação.

Os logs JSON incluem campos de correlação, com null quando não disponíveis. Não expõem payloads financeiros completos, valores monetários, segredos ou stacks integrais de erros. As métricas Prometheus incluem status, duplicatas, retries por worker, DLQ, conflitos de bloqueio, atraso da Outbox, latência e divergências de reconciliação. Cada processo expõe suas próprias métricas; a agregação entre réplicas depende de coleta externa.

A rota de liveness não depende de serviços externos. A de readiness verifica PostgreSQL e SQS. Ambas são acessíveis sem o guard de autenticação. OpenTelemetry, dashboard e benchmark de carga não fazem parte do escopo implementado.
10. Autenticação e autorização
O [`EvaluationAuthGuard`](src/http/evaluation-auth.guard.ts) é intencionalmente um guard sem autenticação efetiva (no-op), conforme a alternativa permitida para o MVP.

Uma implantação em produção exigiria autenticação e autorização reais. Uma opção seria OIDC com Keycloak ou Zitadel, incluindo verificação de assinatura e JWKS, issuer, audience, expiração e associação das claims ao providerId autorizado. A autorização também precisaria verificar acesso a jogador e wallet; UUID não constitui credencial. O projeto não implementa uma base própria de senhas.

As filas operam como canal interno, mas os identificadores das mensagens continuam sujeitos às validações de domínio. As rotas de saúde permanecem públicas.
11. Limitações e condições de avaliação
Não estão incluídos: ledger de partidas dobradas, chargebacks parciais, transferências entre wallets, política de retenção, reconciliação global agendada, benchmark de desempenho ou dashboard de observabilidade.

Nos testes de recuperação, os prazos de lease e visibilidade são antecipados explicitamente para exercitar o mecanismo sem aguardar os períodos completos. A validação foi conduzida em ambiente local com LocalStack 4.0.3, sem implantação na AWS, revisão independente de segurança ou validação regulatória. O sistema não está habilitado para processamento de dinheiro real. Não houve publicação em repositório remoto.

Os resultados de execução e os limites das evidências constam em [`VALIDATION.md`](VALIDATION.md).
Referências
- MikroORM — Transactions and Concurrency
- AWS SQS — Visibility Timeout
- AWS SQS — Outage Recovery
- LocalStack — SQS