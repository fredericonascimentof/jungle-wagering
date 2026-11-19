# Validação executada — 18/11/2026

## Ambiente observado

- Windows local do usuário; código criado do zero, sem acesso ao projeto da outra máquina.
- Bun 1.4.4; TypeScript 5.9.3; NestJS 11.2.11; MikroORM 6.6.18.
- PostgreSQL 18.6 x86_64 Windows, processo real local em 127.0.0.1:55432.
- Migração aplicada com sucesso em `jungle` e `jungle_test`.
- Instalação de dependências concluída, com versões fixadas e `bun.lock`.

## Última execução completa

Comando, na pasta física do projeto:

```powershell
.\scripts\run.ps1 check
```

| Verificação | Resultado |
|---|---|
| TypeScript strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes | Passou, sem erros |
| Domínio Money/Wallet/Wager | 16 testes, 33 asserções, zero falhas |
| Integração PostgreSQL + HTTP | 9 testes, 107 asserções, zero falhas |
| Total | **25 testes, 140 asserções, zero falhas** |

As integrações iniciaram duas aplicações NestJS com EntityManagers/pools
independentes no mesmo processo de testes, usando portas HTTP diferentes.
Isso testa coordenação pelo banco entre instâncias, mas não é ensaio em duas
máquinas nem teste de queda de processo.

## Cenários efetivamente verificados

- Dinheiro exato, limites, entradas negativas/inválidas, moedas incompatíveis.
- Encapsulamento do saldo e transições de aposta, inclusive prêmio zero.
- Uma carteira bloqueada não impede uma operação em outra carteira.
- Replay retorna resposta histórica depois de outras operações.
- 40 apostas concorrentes de 10 sobre saldo 100: 10 sucessos, 30 conflitos,
  saldo final zero e 11 lançamentos contando o depósito.
- 30 requisições duplicadas concorrentes: mesmo resultado, apenas um débito.
- CANCEL e SETTLE concorrentes: apenas um encerramento.
- Wager ID duplicado, aposta de outra carteira e rollback sem débito persistido.
- Formato HTTP, chave obrigatória, overflow, moeda e idempotência entre conexões.
- Banco rejeita saldo negativo/NaN e UPDATE/DELETE/TRUNCATE no ledger;
  DELETE em operações também é rejeitado.
- Reconciliação detecta saldo propositalmente divergente; o teste restaura o saldo.

## Inicialização de uso

O ponto de entrada `src/main.ts` foi iniciado com o Bun instalado no projeto.
A API respondeu em `http://127.0.0.1:3000`. A criação de uma carteira BRL e a
reconciliação de saldo zero passaram por HTTP. A API foi encerrada com Ctrl+C
após essa verificação; o banco local permanece disponível.

Git foi inicializado localmente na branch `main`, sem commit, sem remote e sem
publicação. `.env` e `node_modules` estão excluídos pelo `.gitignore`.

## Não validado / não implementado

- Enunciado completo e código anterior: indisponíveis; compatibilidade exata não verificada.
- Docker Compose/PostgreSQL 17 e workflow GitHub: preparados, não executados.
- SQS, LocalStack, Inbox, Outbox, DLQ: não implementados.
- Autenticação/autorização reais: deliberadamente não implementadas.
- Falha de disco durante uma operação, queda de processo, perda de conexão após
  commit, teste de carga prolongada e recuperação de desastre: não testados.
- Não houve avaliação independente de segurança ou validação para dinheiro real.

O arquivo LICENSE é restritivo na extensão dos direitos existentes e permite
avaliação autorizada; não é uma promessa de exclusividade ou de proteção jurídica
automática de conteúdo gerado com IA.
