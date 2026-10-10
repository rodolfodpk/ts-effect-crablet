# Desenho: virada de período automática no framework (`.period`)

Status: **implementado (2026-10-09) para ano, mês e dia (UTC)**; semana, hora e fuso ficaram de fora; ver [ADR-0025](../adr/0025-the-framework-turns-the-period.md) e as diferenças abaixo. Estado original: proposto, só desenho. Escrito depois de medir o buraco no wallet (`WalletStatementOpened` sem condição perde depósitos; depósito gravado em período já fechado) e de comparar com o padrão "closing the books" (artigo de Oskar Dudycz, fórum do Axon 5). Um conserto pontual no wallet é a alternativa de curto prazo (seção Alternativas).

## Problema

Um modelo escopado por período (o `WalletModel`, por ano e mês) precisa de uma transição quando chega um comando de um período novo: fechar o anterior (`WalletStatementClosed`) e abrir o novo carregando o estado (`WalletStatementOpened` com `openingBalance`). Hoje isso é do desenvolvedor: um `prepare` que chama `resolveActivePeriod`, repetido em cada comando, e `periodTags` no `decide`. Medido: sem a condição certa essa transição perde dinheiro (60 de 60 carteiras com saldo errado numa corrida; um depósito gravado em período já fechado, saldo corrente 115 em vez de 122). A causa de fundo: a transição é gravada fora do caminho de consistência (o `prepare` grava, o `decide` grava depois, dois appends).

## Objetivo

O desenvolvedor declara o período uma vez, no modelo; o comando escreve só `model` e `decide`. O framework faz a virada **no mesmo append atômico** do comando, sob a mesma condição.

## API (o que o desenvolvedor escreve)

```ts
const WalletModel = defineModel({ by: "wallet_id", initial })       // sem `scope`: o período o define
  .lifecycle(WalletOpened, ...)                                      // como hoje
  .on(WalletStatementOpened, (w, d) => ({ ...w, balance: d.openingBalance, statementId: d.statementId }))
  .on(DepositMade, ...)                                              // como hoje
  .period(Period.month, {
    opened: WalletStatementOpened,         // precisa de um `.on(opened)` acima: é a dobra do saldo de abertura
    closed: WalletStatementClosed,         // `.on(closed)` é opcional; sem ele o framework acrescenta um tratador que não altera o estado
    open:  (carry, p) => ({ walletId: p.id, statementId: `wallet:${p.id}:${p.key}`, ...p.fields, openingBalance: carry.balance, openedAt: p.at }),
    close: (state, p) => ({ walletId: p.id, statementId: state.statementId, ...p.fields, openingBalance: state.openingBalance, closingBalance: state.balance, closedAt: p.at })
  });

Deposit = defineCommand({ ...DepositContract,
  model: (c) => WalletModel.of({ id: c.walletId }),                  // sem year/month
  decide: (wallet, c) => wallet.exists
    ? emit(DepositMade({ ... }, [...wallet.period.tags, Tag.of(STATEMENT_ID, wallet.statementId)]))
    : fail(...) });
```

O que o desenvolvedor ainda escreve, sem esconder: o `.on(opened)` (dobra), os campos de estado de que `close` precisa (`statementId`, `openingBalance`, guardados por esse `.on`), e `open`/`close`. Some o que era repetido e fácil de errar: o `prepare` em cada comando, o resolvedor, a leitura do período aberto, a ordem fechar/abrir e as condições dos appends. `p` é `{ id, key, fields, at }` (o `id` é o da entidade; o estado do `WalletModel` não tem `id`).

`.lifecycle(...)` fica como está (opção 1): significa "evento sem escopo de período" e entra no `lifecycleQuery` usado como guarda; **não modela estados nem transições**, que continuam a cargo do `decide`. Veio com o `defineModel` (`264ef0e`, 30/09/2026), herdando a guarda `withLifecycleGuard` de antes.

- `Period.month` é um **valor** exportado (não uma string): carrega o tipo dos campos do período (`{ year, month }`), aceita opções (`Period.day({ timeZone })`, `Period.week({ startsOn: "monday" })`) e combina com `strict()`/`concurrent()`. Uma união de literais também recusaria `"mounth"`, mas não leva parâmetros nem tipa `p.fields` sem um tipo mapeado.
- Cada nível traz pronto o que seria boilerplate: o período corrente pelo relógio (UTC por padrão), o **escopo** do modelo (tags `year`, `month`, `day`, `hour`, `week`), a chave canônica (`"2026-10"`, `"2026-10-09"`, `"2026-10-09T14"`) e qual período um `Opened` abriu (lê os campos do evento). Do lado do desenvolvedor sobram o `.on(opened)`, os campos de estado de que `close` precisa e `open`/`close` (ver acima); `open` e `close` precisam ser puras e totais (rodam também para uma entidade que ainda não existe; se o `decide` recusar, o prefixo é descartado).
- `p` é `{ id, key, fields, at }`. O estado que o `decide` recebe ganha `period: { key, fields, tags }`, tipado (`tags` são as tags de escopo do nível; na transferência, `from.period` e `to.period`).
- `Period.custom({ of, key, scopeOf, fields })` é a saída de emergência (fiscal, turno, id externo).
- Na definição o framework confere que `opened`/`closed` declaram as tags do nível (`year` e `month` para mês); sem elas um período não se separa do outro. A verificar se o evento expõe as chaves de tag sem dados de exemplo; senão vira teste de contrato.
- `carry` é o estado `S` ao fim do período anterior; no primeiro período, o estado só dos eventos de ciclo de vida (o `initialBalance`). Modelo sem `.period` não muda.

## Granularidades

| Nível | Exemplo | Uso típico |
|---|---|---|
| `Period.year` / `month` / `week` / `day` | `Period.month` | balanço, extrato, folha, saldo diário |
| `Period.hour` (fora da v1) | `Period.hour` | janelas de operação; depende do primitivo "o último evento que casa" (ver custo do rastreamento) |
| `Period.custom` | turno, ano fiscal, id externo | caixa por turno, "support period" |

Hoje o wallet só usa mensal; os eventos já têm `day` e `hour` opcionais e as tags existem, sem uso nem teste.

- **Períodos pulados:** um único par `closed`/`opened`, do último aberto para o corrente; sem períodos intermediários vazios.
- **Fuso:** UTC por padrão, como o wallet faz hoje; fuso local só pela opção explícita.
- **Volume:** um par de eventos por período por entidade (mês 12/ano; dia 365; hora ~8.760). A virada é por entidade, no primeiro comando do período; períodos curtos põem mais comandos na janela, que conflitam e repetem uma vez, sem bloqueio global. Guia: limitar os eventos de uma entidade num período.
- **Custo da leitura de rastreamento (limite honesto):** ver o algoritmo; ela lê todos os `opened`/`closed` da entidade, uma vez por período por entidade. Para mês e dia é pequena; para hora cresce sem limite. Recomendação v1: nível mínimo dia; "hora" só depois de um primitivo de leitura "o último evento que casa" (a sonda do caminho de leitura já tem a ideia).
- Testes do framework cobrem ao menos dois níveis (mês e dia).

## Algoritmo (dentro de `load`)

`now` vem do `Clock` do Effect (real em produção, `TestClock` em teste), lido a cada tentativa (uma repetição por conflito relê o relógio). `alvo = P.of(now)`. O framework embrulha o estado do desenvolvedor com duas marcas internas (`opened(alvo)` visto, `closed(alvo)` visto), atualizadas pelos mesmos tratadores; o `S` que o `decide` recebe não as mostra.

**Caminho comum (uma leitura, igual a um modelo comum).** Lê o modelo escopado ao alvo, que inclui o ciclo de vida e, tratados pelo framework, `opened` e `closed` do alvo. Se `opened(alvo)` existe e `closed(alvo)` não: devolve o estado, sem prefixo. A fronteira do comando já contém o `closed(alvo)`: quem decidiu num período que fechou depois **conflita**.

**Caminho de virada (só quando o alvo não está aberto, ou está fechado).**
1. Lê o rastreamento: todos os `opened`/`closed` do id, sem escopo; o último decide qual período `X` está aberto.
2. `X` posterior ao alvo, ou o alvo já fechado (relógio atrasado): **nunca voltar**; o alvo passa a ser `X` e segue o caminho comum (com uma métrica).
3. `X` anterior ao alvo: lê o período `X` (estado final). Prefixo: `closed(X)` e `opened(alvo)`; `carry` é o estado de `X`.
4. Nenhum período: `carry` é o estado só do ciclo de vida (já lido); prefixo: `opened(alvo)`.
5. O estado novo é o do caminho comum com o `opened` sintético dobrado.
6. `Loaded.logPosition` é o **horizonte mais antigo** de todas as leituras (a primeira); a fronteira é a união (alvo + rastreamento + período `X`).

**Execução (`Command.ts`).** Com prefixo: grava `[...prefixo, ...eventos do decide]` num só append, com condição **estrita** sobre a fronteira ampliada, mesmo num comando `concurrent` (os eventos do comando caem no período novo, então não conflitam com o período antigo). Sem prefixo: um `concurrent` recebe, além da guarda que declarou, a guarda automática `closed(alvo)` (hoje um `concurrent` sem guarda não tem condição nenhuma). `Fail`, `Noop`, idempotente ou sem eventos: o prefixo nunca é gravado (nada a desfazer).

## Por que resolve (e o que cada garantia depende de)

- **Atomicidade:** virada e eventos do comando entram juntos ou nenhum; nada fica sem comando por trás.
- **Abertura única:** duas viradas concorrentes conflitam (ambas leram o rastreamento; a fronteira o contém); uma repete e cai no caminho comum.
- **Escritor atrasado:** quem não vira tem `closed(alvo)` na fronteira; quem vira tem o período antigo, então conflita se ele recebeu evento depois da leitura (o `carry` nunca fica velho).
- **Janela entre leituras:** fechada **porque o cursor é o horizonte da primeira leitura**; um evento que casa com a união e comita depois dela conflita. Se a implementação usasse a posição da última leitura, a janela reabriria; é um requisito e tem teste.
- **Responsabilidade do desenvolvedor:** some. Sem `prepare`, sem `resolveActivePeriod`, sem `periodTags` por parâmetro.

## Limites (o que não resolve)

- Protege **só** comandos cujo modelo declara `.period`; um comando que grava eventos com tags de período sem esse modelo não é coberto.
- Um `concurrent` que vira passa a ser estrito naquela chamada (documentado): conflito e repetição uma vez por período por entidade.
- `decide` ainda chama `new Date()` para campos informativos (`depositedAt`); com `TestClock` pode divergir do período. Seguimento: `ctx.now`.
- Interação com snapshots de modelo (ADR-0018): a chave do snapshot de um modelo periódico precisa incluir o período. A verificar.
- Logs existentes têm `Closed` só em períodos com transações; "o último evento de rastreamento decide" lê isso corretamente. A confirmar com os fixtures.

## Pontos de integração (arquivos)

- `packages/commands/src/Model.ts`: `.period(...)`, `Period`, `of` sem escopo para modelo periódico, `Loaded` com `prefix?`/`boundary?`/`periodGuard?`; `all` os combina (prefixos concatenados, consultas unidas, horizonte mais antigo).
- `packages/commands/src/Command.ts`: injeta o prefixo, amplia a condição, aplica a guarda automática; o comentário do `prepare` passa a recomendar só leitura (não é imposto; a reversão de resultado idempotente já cobre os appends que sobrarem).
- Chamadores de `WalletModel.of({ id, year, month })` (testes, `prepare-appends`, `unguarded-opening-balance`): passam a `of({ id })` com o relógio, ou a um modelo escopado à parte nos testes que fixam um mês.
- `packages/commands/src/CommandDecision.ts`: caminho de condição para a virada sem a checagem de tipos sobrepostos de `withLifecycleGuard`.
- `packages/commands/src/testing/Scenario.ts`: relógio de teste (`given(...).at(date)`).
- `packages/commands/src/ModelImpact.ts`: `opened`/`closed` contam como tratados; remover a linha `WalletModel/WalletStatementClosed` do baseline do wallet.
- Wallet: remove `prepare`, `resolveActivePeriod`, `StatementTracking`, `periodTags` por parâmetro; mantém eventos e views.

## Alternativas

- **Conserto pontual no wallet** (3 a 4 h: `Closed` na fronteira, resolvedor sempre fecha): fecha o buraco de dinheiro hoje, mantém a responsabilidade no desenvolvedor e deixa a janela `prepare`→`load`. Passo intermediário possível; os testes de regressão valem para os dois.
- **`decide` emitir a virada em cada comando:** funciona, repete a lógica em cada comando de cada modelo.
- **Máquina de estados declarativa:** consultada no `decide`, não grava a transição; não resolve a atomicidade.

## Critérios de aceitação

Regressão do depósito atrasado com **dois pontos de pausa**, antes do `load` (a janela que o experimento mediu: saldo corrente 115 em vez de 122) e depois do `load` (a janela do lock), saque e transferência equivalentes (a transferência vira duas carteiras de uma vez), período sem transações, virada concorrente (4 depósitos de valores diferentes em 60 carteiras: saldo certo, uma abertura, um fechamento), comando que falha ou dá `Noop` não grava a virada, relógio atrasado (nunca volta), `Scenario` com relógio, dois níveis (mês e dia), controle de mutação (horizonte da última leitura faz o teste da janela falhar). `statement-open-race`, `unguarded-opening-balance`, `prepare-appends` e `statement-view` continuam verdes.

## Estimativa

4 a 5 dias: `Model`/`Command`/executor (2), `all` e `Scenario` (0,5), migração do wallet (0,5), testes, documentação e ADR (1,5). O código do desenvolvedor encolhe; a complexidade se concentra em `Model.ts` e `Command.ts`, e é maior do que o conserto pontual.

## Como ficou (diferenças em relação ao desenho)

- **Wallet:** `WalletModel` (um período explícito, para leituras e testes) continua; `WalletPeriodModel` (o período corrente) vem do mesmo `defineModel`, e os comandos usam este. O estado do `WalletModel` não ganhou campos: o `statementId` é determinístico (`wallet:<id>:<chave>`) e o `openingBalance` do `Closed` é o saldo, como era.
- **`Period`:** `Period.year`, `Period.month`, `Period.day` e `Period.custom(spec)` (a especificação inteira: `fieldsAt`, `fieldsOf`, `key`, `tagKeys`). Sem `week`, `hour` e fuso.
- **Janela entre `prepare` e `load`:** não existe mais (não há `prepare`). Os testes que pausavam ali foram removidos.
- **Não feito (e feito depois, ver `period-follow-ups.md`):** métrica do relógio atrasado (`crablet.period.clock_behind`); `ctx.now` no `decide`; validação **na definição** de que `opened`/`closed` declaram as tags do nível: um `defineEvent` não expõe suas chaves de tag sem dados, então a conferência é feita na primeira virada, nos eventos que o framework monta (erro nomeando a tag que falta; teste em `period.test.ts`).
- **Mutação:** retirar a guarda do período faz o depósito atrasado e o período vazio falharem; usar a posição da última leitura em vez do horizonte mais antigo faz seis testes falharem.
