# Jungle Gaming — Wagering Processor MVP

Implementação local para avaliação técnica: Bun 1.x, NestJS, TypeScript estrito,
PostgreSQL, MikroORM e dinheiro exato com decimal.js. Criada do zero, preservando
as decisões recuperadas da conversa anterior sobre `MoneyProps`, construtor
privado e validação dentro de `Money.from()`.

**Escopo honesto:** o núcleo financeiro HTTP está implementado. SQS, LocalStack,
Inbox e Outbox **não estão implementados**. Não há autenticação real.
O enunciado `/mnt/data/Texto colado(1).txt` não estava disponível; não é possível
afirmar aderência integral aos contratos originais. Veja [ARCHITECTURE.md](ARCHITECTURE.md).

## Abrir e executar nesta máquina

Abra esta pasta no VS Code. As dependências e o `.env` já foram preparados.
O PostgreSQL local foi iniciado em `127.0.0.1:55432`.

No terminal PowerShell, dentro da pasta do projeto:

```powershell
.\scripts\run.ps1 check
.\scripts\run.ps1 start
```

O segundo comando mantém a API em `http://127.0.0.1:3000`. Ctrl+C encerra a API.
Se o computador tiver sido reiniciado, primeiro reinicie o banco conforme
[LOCAL_ENVIRONMENT.md](LOCAL_ENVIRONMENT.md). Não execute simultaneamente o banco
local e o Compose na mesma porta.

## Reproduzir em outra máquina

Pré-requisitos: Bun 1.x (validado com 1.4.4) e Docker com Compose ativo.

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
docker compose up -d --wait postgres
bun run db:migrate
bun run check
bun run start
```

O Compose cria `jungle` e `jungle_test` apenas na primeira inicialização do
volume. Caso utilize PostgreSQL existente, crie esses bancos antes e ajuste as
URLs. Não use comandos que apaguem volumes para resolver configuração.
Migrações são explícitas; iniciar a API não altera automaticamente o schema.

## API

| Método | Rota | Uso |
|---|---|---|
| PUT | `/wallets/:uuid` | Cria carteira vazia; repetir mesma moeda é seguro |
| GET | `/wallets/:uuid` | Consulta saldo atual |
| POST | `/wallets/:uuid/operations` | Executa operação com `Idempotency-Key` obrigatório |
| GET | `/wallets/:uuid/reconciliation` | Compara saldo e histórico sob o mesmo lock |

Operações aceitas (campos extras são rejeitados):

```json
{"type":"DEPOSIT","amount":"100.00","currency":"BRL"}
{"type":"PLACE","wagerId":"UUID","amount":"10.00","currency":"BRL"}
{"type":"SETTLE","wagerId":"UUID","amount":"25.00","currency":"BRL"}
{"type":"CANCEL","wagerId":"UUID"}
```

`SETTLE.amount` é o **prêmio total a creditar**, não o lucro nem um multiplicador.
Zero representa perda. CANCEL devolve o valor originalmente apostado. Uma aposta
só pode ser encerrada uma vez. DEPÓSITO é uma facilidade de avaliação, sem
integração com pagamentos. Carteiras começam em zero; não há saldo inicial oculto.

### Exemplo completo em PowerShell

```powershell
$base = 'http://127.0.0.1:3000'
$walletId = [guid]::NewGuid().ToString()
$wagerId = [guid]::NewGuid().ToString()
Invoke-RestMethod "$base/wallets/$walletId" -Method Put -ContentType 'application/json' -Body '{"currency":"BRL"}'
Invoke-RestMethod "$base/wallets/$walletId/operations" -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='deposit-1'} -Body '{"type":"DEPOSIT","amount":"100.00","currency":"BRL"}'
$bet = @{type='PLACE'; wagerId=$wagerId; amount='10.00'; currency='BRL'} | ConvertTo-Json
Invoke-RestMethod "$base/wallets/$walletId/operations" -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='bet-1'} -Body $bet
# Repita a chamada acima: mesma resposta, sem novo débito.
$settle = @{type='SETTLE'; wagerId=$wagerId; amount='25.00'; currency='BRL'} | ConvertTo-Json
Invoke-RestMethod "$base/wallets/$walletId/operations" -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='settle-1'} -Body $settle
Invoke-RestMethod "$base/wallets/$walletId"
Invoke-RestMethod "$base/wallets/$walletId/reconciliation"
```

Saldo esperado: **115.00**, com três lançamentos e `consistent: true`.
Cada intenção nova recebe uma chave nova; um retry mantém a chave e o conteúdo.
A resposta repetida contém o saldo da operação original; consulte GET para o atual.

### Erros

400: formato inválido ou chave ausente; 404: carteira/aposta não encontrada;
409: saldo insuficiente, aposta fechada/duplicada ou conflito de idempotência;
422: valor/moeda/regra monetária inválida; 503: conflito transitório, retry com
a mesma chave; 500: falha inesperada sem detalhes internos na resposta.

## Testes e evidências

`bun run test` executa o domínio. `bun run test:integration` exige PostgreSQL real
em uma URL cujo banco termine em `_test`; falha se ele estiver indisponível.
Os testes sobem duas aplicações NestJS com pools independentes e enviam HTTP
concorrente. Não há mock de banco nem mutex em memória. Geram UUIDs próprios e
preservam os registros; não truncam tabelas como limpeza.

Consulte [VALIDATION.md](VALIDATION.md) para resultados efetivamente executados.
O workflow de CI está preparado, mas não foi executado no GitHub.

## Estudo e direitos

Leia [STUDY_GUIDE.md](STUDY_GUIDE.md) para explicações, exercícios e perguntas
vinculados aos arquivos. A implementação teve assistência de IA; não apresente
o código como trabalho exclusivamente humano ou como experiência que não viveu.

[LICENSE](LICENSE) permite avaliação pelos destinatários autorizados e restringe
uso comercial não autorizado, na extensão dos direitos existentes. Não altera
licenças de dependências nem contratos aplicáveis. Os termos do serviço de IA
também devem ser respeitados: [termos OpenAI](https://openai.com/policies/terms-of-use/)
e, quando aplicável, [contrato de serviços](https://openai.com/policies/services-agreement/).
Nenhum repositório remoto foi criado ou publicado.
