# Entender, modificar e defender esta implementação

## Comece pelo caminho de uma aposta

Uma carteira tem R$ 100. O cliente pede uma aposta de R$ 10. O
[controller](src/http/app.ts) recebe o pedido e chama o
[serviço](src/application/wagering.service.ts). O serviço valida os campos, cria
um Money e abre uma transação. Ele trava a linha da carteira no PostgreSQL.
Enquanto isso, outra requisição para a mesma carteira precisa esperar.

Com a carteira travada, ele confere se aquela chave já foi usada. Se foi, devolve
o resultado salvo. Se não foi, [Wager.place](src/domain/wager.ts) pede à
[Wallet](src/domain/wallet.ts) para debitar R$ 10. A Wallet não aceita ficar
negativa. A aposta, o lançamento de -10, o saldo 90 e a resposta ficam na mesma
transação. Ou tudo é confirmado, ou nada fica gravado.

O ledger é o extrato: registra o que aconteceu. O saldo da carteira é um resumo
rápido desse extrato. A reconciliação soma o extrato novamente e verifica se o
resumo e cada saldo intermediário estão corretos. Isso explica por que guardar
apenas o saldo seria insuficiente para investigar um erro.

## Por que as decisões foram tomadas

| Decisão | Problema que resolve | Limite que você precisa reconhecer |
|---|---|---|
| String + Decimal | Evita erros de ponto flutuante em dinheiro | Strings ainda precisam ser validadas |
| Fábrica `Money.from` | Centraliza a criação válida, inclusive fora de HTTP | `private` do TS não protege runtime sozinho |
| Wallet e Wager | Regras existem independentemente de NestJS | Persistência continua responsabilidade do serviço |
| Transação | Impede saldo atualizado sem histórico correspondente | Não inclui serviços externos |
| Lock no PostgreSQL | Duas APIs não gastam simultaneamente o mesmo saldo | Mesma carteira vira ponto de serialização |
| Chave persistida | Retry não debita novamente | Erros anteriores ao commit não são memorizados |
| Constraints e triggers | Banco também rejeita dados incoerentes e edição do histórico | Administrador privilegiado pode contornar proteções |
| SQL parametrizado | Valores não viram comandos SQL | SQL explícito exige atenção ao contexto transacional |
| Guard vazio explícito | Mantém foco e ponto de extensão solicitado | Nenhuma identidade está sendo verificada |
| Teste com banco real | Exercita locks, constraints, transações e driver | Não substitui teste de produção ou carga prolongada |

## Exercícios práticos

Execute em uma cópia/branch de estudo. Use apenas o banco `_test`. Antes de editar,
rode `check`. Para cada exercício, anote hipótese, mudança, teste e resultado.
Os itens marcados **extensão** são propostas de estudo, não recursos entregues.

1. **Siga a entrada.** Em [app.ts](src/http/app.ts), localize o método que recebe
   `Idempotency-Key`. Desenhe o caminho até `em.flush()` no serviço. Onde começa
   a transação? Qual linha garante que o HTTP aguarda o commit?
2. **Validação além do controller.** Chame `Money.from({amount:'-50.00',currency:'BRL'})`
   em [money.test.ts](tests/unit/money.test.ts). O que deve acontecer? Explique
   por que o futuro consumidor SQS também precisa dessa validação.
3. **Precisão.** Compare `0.1 + 0.2` com a soma de Money. Use `9999999999999999.98`
   mais `0.01`. O que falharia se o código convertesse tudo com `Number()`?
4. **Construção privada.** Tente criar `new Money(...)` em um teste temporário e
   execute `typecheck`. Depois explique a diferença entre erro de compilação e
   validação de dados recebidos em runtime.
5. **Formato.** Proponha testes para `"01"`, `"1e3"`, `" 10"`, `"1.001"`, `10`
   e `"10.0"`. Quais passam? Mostre a normalização do último.
6. **Limite.** Some um centavo ao máximo aceito. Em que camada o overflow é
   rejeitado? O saldo original mudou? Prove com um teste.
7. **Moeda.** Tente liquidar aposta BRL com prêmio USD. Confira que status e saldo
   permanecem iguais. Leia [wager.test.ts](tests/unit/wager.test.ts).
8. **Saldo encapsulado.** Em [wallet.ts](src/domain/wallet.ts), identifique quem
   pode reatribuir o saldo. Como uma camada de fila poderia usar o mesmo domínio?
9. **Máquina de estados.** Desenhe PLACED, SETTLED e CANCELLED. Faça um teste que
   cancela duas vezes e outro que liquida depois de cancelar. Por que ambos falham?
10. **Significado do prêmio.** Deposite 100, aposte 10 e liquide 25 usando o exemplo
    do README. Por que o saldo final é 115, e não 125 ou 105?
11. **Perda.** Liquide com zero. O que muda na aposta? Por que ainda há um lançamento
    no ledger? Mostre que o saldo permanece depois do débito original.
12. **Replay.** Reenvie a mesma chave 30 vezes. Localize esse cenário em
    [wagering.test.ts](tests/integration/wagering.test.ts). Quais verificações
    demonstram que houve só um débito, além de todas responderem 200?
13. **Conflito de intenção.** Reuse a chave mudando 10 para 11. O que deve retornar?
    Depois mude apenas `"10.00"` para `"10"`. Por que a resposta é diferente?
14. **Resposta histórica.** Faça depósito de 10 com chave A, depósito de 5 com B,
    e repita A. Compare o saldo do replay com GET. Explique por que isso é correto.
15. **Erro não memorizado.** Em uma carteira vazia, tente apostar 10 com chave A.
    Deposite 10 e repita A. Preveja o resultado e escreva um teste. Essa política
    seria adequada para qualquer contrato de negócio?
16. **Concorrência real.** Altere o cenário de 40 apostas para saldo 50 e apostas 7.
    Quantas devem passar? Qual saldo deve restar? Resposta esperada: 7 e 1.00.
17. **Lock por carteira.** Leia o teste que mantém uma carteira travada enquanto
    opera outra. O que ele comprova? Por que um mutex JavaScript não resolveria
    o caso de duas máquinas diferentes?
18. **Corrida no encerramento.** Execute a disputa entre CANCEL e SETTLE. Qual
    operação deve ganhar? Explique por que o teste aceita dois saldos finais,
    mas exige exatamente um sucesso e um conflito.
19. **Rollback.** Tente apostar com wagerId já usado em outra carteira. Compare o
    saldo antes/depois e a reconciliação. Por que o débito em memória não vira
    débito persistido quando a constraint rejeita a gravação?
20. **Proteção no banco.** Leia cada FK e CHECK da
    [migration](src/database/migrations/Migration202611180001.ts). Relacione-os
    a moeda errada, carteira inexistente, aposta duplicada, NaN e saldo negativo.
    Por que existe uma regra explícita contra NaN?
21. **Append-only.** Localize o trigger e o teste que tenta UPDATE/DELETE/TRUNCATE.
    Proponha uma correção financeira que adicione um lançamento compensatório,
    sem alterar o passado. **Extensão:** especifique o contrato antes de codificar.
22. **Reconciliação.** Explique `sum(delta) over(order by sequence)`. Como isso
    detecta um saldo intermediário incorreto mesmo quando o saldo final confere?
    **Extensão:** adicione teste para corrupção de cadeia em um banco descartável.
23. **Autorização.** Leia [evaluation-auth.guard.ts](src/http/evaluation-auth.guard.ts).
    O que precisaria mudar para impedir que uma pessoa movimente carteira alheia?
    Diferencie autenticação, autorização e integridade. Não diga que UUID é senha.
24. **Fila e falhas.** **Extensão:** desenhe Inbox/Outbox. O que acontece se o worker
    envia um evento e cai antes de marcá-lo como enviado? Defina um teste de
    reentrega antes de implementar qualquer integração com SQS.
25. **Revisão independente.** **Extensão:** proponha como injetar falha depois da
    atualização da aposta e antes do ledger; prove rollback de todas as tabelas.
    O teste atual de rollback não é uma simulação completa de queda do processo.
26. **Operação e escala.** **Extensão:** projete um relatório paginado por carteira
    e um job de reconciliação global. Como evitar travar milhões de carteiras em
    uma única transação? Quais métricas mediriam contenção e retries?

## Perguntas de entrevista e o que uma resposta deve conter

1. **Transação e lock são a mesma coisa?** Não. Transação define o conjunto
   atômico; lock controla interferência concorrente no acesso ao saldo.
2. **Por que olhar a chave depois do lock?** Pedidos concorrentes da mesma carteira
   ficam serializados antes da consulta; o segundo observa o commit do primeiro.
3. **E se duas instâncias receberem a mesma aposta?** O banco é o coordenador
   compartilhado; chave persistida, lock e unicidade de wagerId protegem a operação.
4. **O que acontece se o cliente não receber a resposta?** Se houve commit, retry
   retorna o JSON salvo. Se não houve commit, a operação pode ser executada.
5. **Isso garante exactly-once?** Garante efeito financeiro idempotente nesse
   contrato de banco e chave. Não garante entrega única de rede ou de mensagens.
6. **Por que `numeric(18,2)` e Decimal?** Representação decimal exata dos valores
   aceitos. A API rejeita precisão extra antes que o banco possa arredondá-la.
7. **O banco sozinho garante tudo?** Não. Ele impõe constraints locais e vínculos;
   igualdade entre saldo e histórico depende também do protocolo transacional.
8. **O ledger é uma blockchain ou contabilidade dupla?** Não. É histórico relacional
   append-only por trigger, sem hash chain nem contas de contrapartida.
9. **Por que não usar `schema:update`?** Há tabelas e triggers mantidos por migration
   que não têm metadados completos no ORM. Alteração automática seria inadequada.
10. **Como o sistema escala?** Carteiras distintas podem avançar em paralelo;
    uma carteira muito ativa enfrenta contenção. Medir antes de mudar o modelo.
11. **O que falta antes de produção?** Identidade e autorização, papéis de banco,
    gestão de segredos, observabilidade, limites, operação/backup, filas quando
    requeridas, testes de falhas e regras completas do negócio, entre outros.
12. **Por que não foi implementado SQS?** A prioridade autorizada foi a integridade
    do MVP. Existe desenho documentado, mas consumidor e Inbox/Outbox não existem.
13. **Como você participou da construção?** Diferencie o que definiu, estudou,
    executou e alterou do que foi gerado com assistência. Não invente autoria.
14. **Qual teste você acrescentaria primeiro?** Uma boa resposta explica um risco
    ainda não provado: falha tardia de persistência, queda após commit antes da
    resposta, saturação do pool ou reentrega de fila após envio do Outbox.

## Como apresentar sem decorar uma história falsa

Use como base, ajustando apenas ao que você realmente fez:

“O projeto foi desenvolvido com assistência de IA. Mantive o foco em integridade
financeira: valores exatos, transação por operação, lock por carteira e histórico
imutável. Revisei [diga o que realmente revisou] e executei [diga quais testes
realmente executou]. Sei explicar como o retry evita débito duplicado e quais
limitações permanecem. SQS e autenticação real não fazem parte desta entrega.”

Você estará pronto quando conseguir alterar um teste, prever o resultado,
explicar uma falha e corrigir a regra sem depender de repetir esse texto.
